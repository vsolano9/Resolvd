import type { Decision } from "./policy";
import { realShopAdapter } from "./shopify";
import { emailConfigured, resendMailAdapter } from "./email";

/** Production adapters from env. Mail is null unless email is configured. */
export function liveAdapters(env: NodeJS.ProcessEnv = process.env): {
  shop: ShopAdapter;
  mail: MailAdapter | null;
} {
  return {
    shop: realShopAdapter(
      env.SHOPIFY_SHOP_DOMAIN as string,
      env.SHOPIFY_ACCESS_TOKEN as string,
      env.SHOPIFY_API_BASE,
    ),
    mail:
      env.RESEND_API_KEY && env.RESEND_FROM_EMAIL
        ? resendMailAdapter(env.RESEND_API_KEY, env.RESEND_FROM_EMAIL)
        : null,
  };
}

export function mailConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return emailConfigured(env);
}

export interface ShopOrder {
  id: string;
  name: string;
  email: string | null;
  currency: string;
  total: string | null;
  status: string;
}

/** Store integration. The demo route passes a sample store; production passes Shopify. */
export interface ShopAdapter {
  lookupByName(name: string): Promise<ShopOrder | null>;
  lookupByEmail(email: string): Promise<ShopOrder[]>;
  createRefund(orderId: string, amount: number, currency: string): Promise<{ refundId: string }>;
}

export interface MailAdapter {
  sendReply(to: string, subject: string, text: string): Promise<void>;
}

export interface ExecutionContext {
  sender: string;
  subject: string;
  orderRef: string | null;
}

export type ExecutionResult =
  | { ok: true; actionTaken: string }
  | { ok: false; proposedAction: string; reason: string };

function replySuffix(mail: boolean): string {
  return mail ? "Confirmation email sent." : "Reply draft saved (email not configured).";
}

// Pin down which order money would move on. Prefers an explicit reference;
// falls back to the sender email only when it matches exactly one order.
// Anything ambiguous escalates: never guess with refunds.
export async function findOrderForRefund(
  shop: ShopAdapter,
  orderRef: string | null,
  senderEmail: string,
): Promise<
  | { ok: true; order: ShopOrder }
  | { ok: false; proposedAction: string; reason: string }
> {
  if (orderRef) {
    let order: ShopOrder | null;
    try {
      order = await shop.lookupByName(orderRef);
    } catch (e) {
      return {
        ok: false,
        proposedAction: "Confirm the order, then approve the refund",
        reason: `order lookup failed: ${(e as Error).message}`,
      };
    }
    if (!order) {
      return {
        ok: false,
        proposedAction: `Find order ${orderRef} and confirm the refund`,
        reason: `order ${orderRef} not found in the store`,
      };
    }
    return { ok: true, order };
  }
  let matches: ShopOrder[];
  try {
    matches = await shop.lookupByEmail(senderEmail);
  } catch (e) {
    return {
      ok: false,
      proposedAction: "Confirm the order, then approve the refund",
      reason: `order lookup failed: ${(e as Error).message}`,
    };
  }
  if (matches.length === 0) {
    return {
      ok: false,
      proposedAction: "Ask the customer for their order number, then approve",
      reason: "no recent order matches the sender email",
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      proposedAction: `Confirm which of the ${matches.length} recent orders to refund, then approve`,
      reason: "sender email matches multiple orders, refusing to guess",
    };
  }
  return { ok: true, order: matches[0] };
}

export async function executeResolution(
  decision: Decision,
  ctx: ExecutionContext,
  shop: ShopAdapter,
  mail: MailAdapter | null,
  sample: boolean,
): Promise<ExecutionResult> {
  const tag = sample ? "Sample store: " : "";
  const kind = decision.execution?.kind;

  try {
    if (kind === "order_lookup" && ctx.orderRef) {
      const order = await shop.lookupByName(ctx.orderRef);
      if (!order) {
        return {
          ok: false,
          proposedAction: `Find order ${ctx.orderRef} and reply manually`,
          reason: `order ${ctx.orderRef} not found in the store`,
        };
      }
      const reply = `Hi, your order ${order.name} is currently "${order.status}". ${decision.draftReply}`;
      if (mail) await mail.sendReply(ctx.sender, `Re: ${ctx.subject}`, reply);
      return {
        ok: true,
        actionTaken: `${tag}Replied with live status "${order.status}" for ${order.name}. ${replySuffix(!!mail)}`,
      };
    }

    if (kind === "refund" && decision.execution?.amount != null) {
      const amount = decision.execution.amount;
      const found = await findOrderForRefund(shop, ctx.orderRef, ctx.sender);
      if (!found.ok) return found;
      const { refundId } = await shop.createRefund(found.order.id, amount, found.order.currency);
      const reply = `Hi, we've issued your refund of $${amount} on order ${found.order.name}. ${decision.draftReply}`;
      if (mail) await mail.sendReply(ctx.sender, `Re: ${ctx.subject}`, reply);
      return {
        ok: true,
        actionTaken: `${tag}Refunded $${amount} on ${found.order.name} (refund ${refundId}). ${replySuffix(!!mail)}`,
      };
    }

    return {
      ok: false,
      proposedAction: "Human review (nothing executable)",
      reason: "decision carried no executable action",
    };
  } catch (e) {
    return {
      ok: false,
      proposedAction: "Retry or handle manually",
      reason: `execution failed: ${(e as Error).message}`.slice(0, 200),
    };
  }
}

// Explicitly fake store for the public demo. Labels everything it touches so
// demo resolutions read as a simulation, never as real store activity.
export function sampleShopAdapter(): ShopAdapter {
  const orders: ShopOrder[] = [
    { id: "9001", name: "#1042", email: "sam@buyer.com", currency: "USD", total: "84.00", status: "shipped" },
    { id: "9002", name: "#1043", email: "jo@buyer.com", currency: "USD", total: "18.00", status: "delivered" },
  ];
  return {
    async lookupByName(name: string) {
      const ref = name.trim().startsWith("#") ? name.trim() : `#${name.trim()}`;
      return orders.find((o) => o.name === ref) ?? null;
    },
    async lookupByEmail(email: string) {
      return orders.filter((o) => o.email === email.trim());
    },
    async createRefund(orderId: string) {
      return { refundId: `sample-${orderId}` };
    },
  };
}
