import type { InboundPayload, Triage } from "./types";

export interface Integrations {
  shopify: boolean;
  email: boolean;
}

export function readIntegrations(env: NodeJS.ProcessEnv = process.env): Integrations {
  return {
    shopify: Boolean(env.SHOPIFY_SHOP_DOMAIN && env.SHOPIFY_ACCESS_TOKEN),
    email: Boolean(env.RESEND_API_KEY && env.RESEND_FROM_EMAIL),
  };
}

export type ExecutionPlan =
  | { kind: "order_lookup" }
  | { kind: "refund"; amount: number };

export interface Decision {
  status: "resolved" | "escalated";
  proposedAction: string;
  actionTaken: string | null; // set only after successful execution
  reason: string;
  draftReply: string;
  // Present when status is resolved: what the executor may run.
  execution: ExecutionPlan | null;
}

// The guardrail layer. Decides whether the agent may act on its own or must
// escalate to a human, given the triage, the configured limits, and which
// integrations are actually connected. A resolved decision never executes
// anything by itself; lib/execute.ts runs the plan and reports back.
export function decide(
  triage: Triage,
  payload: InboundPayload,
  integrations: Integrations = readIntegrations(),
): Decision {
  const refundAutoLimit = Number(
    process.env.REFUND_AUTO_LIMIT ?? "50",
  );
  const resolved = (
    proposedAction: string,
    execution: ExecutionPlan,
    reason: string,
  ): Decision => ({
    status: "resolved",
    proposedAction,
    actionTaken: null,
    reason,
    draftReply: triage.draftReply,
    execution,
  });

  const escalated = (proposedAction: string, reason: string): Decision => ({
    status: "escalated",
    proposedAction,
    actionTaken: null,
    reason,
    draftReply: triage.draftReply,
    execution: null,
  });

  // Negative + high urgency always goes to a human, regardless of category.
  if (triage.sentiment === "negative" && triage.urgency === "high") {
    return escalated(
      "Personal apology + offer remedy",
      "negative sentiment at high urgency, needs a human touch",
    );
  }

  switch (triage.category) {
    case "order_status": {
      if (!payload.orderId) {
        return escalated(
          "Ask customer for their order number",
          "order status request without an order id",
        );
      }
      if (!integrations.shopify) {
        return escalated(
          `Look up ${payload.orderId} in the store and reply`,
          "store not connected, cannot verify live status",
        );
      }
      // Safe, read-only auto-resolution: the executor looks up live status.
      return resolved(
        `Reply with live status for ${payload.orderId}`,
        { kind: "order_lookup" },
        "read-only lookup, safe to auto-handle",
      );
    }

    case "refund": {
      const amount = triage.refundAmount ?? null;
      if (amount != null && (!Number.isFinite(amount) || amount <= 0)) {
        return escalated(
          "Confirm a valid refund amount, then approve",
          "refund amount must be finite and greater than zero",
        );
      }
      if (amount == null) {
        return escalated(
          "Confirm refund amount, then approve",
          "refund amount not stated",
        );
      }
      if (amount > refundAutoLimit) {
        return escalated(
          `Approve refund of $${amount}`,
          `refund $${amount} exceeds auto-limit $${refundAutoLimit}`,
        );
      }
      if (!integrations.shopify) {
        return escalated(
          `Issue refund of $${amount} in the store`,
          "store not connected, cannot move money automatically",
        );
      }
      if (!payload.orderId && !payload.sender) {
        return escalated(
          `Confirm which order the $${amount} refund belongs to, then approve`,
          "no order reference and no sender to match against",
        );
      }
      return resolved(
        `Issue refund of $${amount}`,
        { kind: "refund", amount },
        `refund $${amount} <= auto-limit $${refundAutoLimit}`,
      );
    }

    case "complaint":
      return escalated(
        "Review complaint and respond personally",
        "complaints are routed to a human by policy",
      );

    default:
      return escalated(
        "Human review (uncategorized)",
        "could not confidently categorize",
      );
  }
}
