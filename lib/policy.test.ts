import { afterEach, describe, expect, it } from "vitest";
import { decide } from "./policy";
import type { InboundPayload, Triage } from "./types";

const base: Triage = {
  category: "other",
  urgency: "normal",
  sentiment: "neutral",
  summary: "test",
  draftReply: "Thanks for reaching out.",
};

const payload: InboundPayload = {
  sender: "sam@buyer.com",
  subject: "test",
  body: "test body",
};

// Store + email connected, so these tests exercise the execution plans
// rather than the degraded paths (covered separately below).
const ON = { shopify: true, email: false };

afterEach(() => {
  delete process.env.REFUND_AUTO_LIMIT;
});

describe("decide", () => {
  it("auto-resolves a small refund within the default $50 limit", () => {
    const d = decide(
      { ...base, category: "refund", refundAmount: 20 },
      { ...payload, orderId: "1042" },
      ON,
    );
    expect(d.status).toBe("resolved");
    expect(d.execution).toEqual({ kind: "refund", amount: 20 });
    expect(d.actionTaken).toBeNull();

    const atLimit = decide(
      { ...base, category: "refund", refundAmount: 50 },
      { ...payload, orderId: "1042" },
      ON,
    );
    expect(atLimit.status).toBe("resolved");
    expect(atLimit.execution).toEqual({ kind: "refund", amount: 50 });
  });

  it("escalates a refund over the limit with an approval proposal", () => {
    const d = decide(
      { ...base, category: "refund", refundAmount: 640 },
      payload,
      ON,
    );
    expect(d.status).toBe("escalated");
    expect(d.actionTaken).toBeNull();
    expect(d.execution).toBeNull();
    expect(d.proposedAction).toMatch(/\$640/);
  });

  it("escalates a refund with no stated amount", () => {
    const d = decide({ ...base, category: "refund" }, payload, ON);
    expect(d.status).toBe("escalated");
    expect(d.proposedAction).toMatch(/amount/i);
  });

  it("escalates non-positive and non-finite refund amounts", () => {
    for (const refundAmount of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      const d = decide(
        { ...base, category: "refund", refundAmount },
        payload,
        ON,
      );
      expect(d.status).toBe("escalated");
      expect(d.execution).toBeNull();
      expect(d.proposedAction).toBe(
        "Confirm a valid refund amount, then approve",
      );
      expect(d.reason).toBe(
        "refund amount must be finite and greater than zero",
      );
    }
  });

  it("honors a custom REFUND_AUTO_LIMIT", () => {
    process.env.REFUND_AUTO_LIMIT = "10";
    expect(
      decide({ ...base, category: "refund", refundAmount: 20 }, payload, ON)
        .status,
    ).toBe("escalated");
    expect(
      decide({ ...base, category: "refund", refundAmount: 5 }, payload, ON)
        .status,
    ).toBe("resolved");
  });

  it("auto-resolves order status when an order id is present", () => {
    const d = decide({ ...base, category: "order_status" }, {
      ...payload,
      orderId: "1042",
    }, ON);
    expect(d.status).toBe("resolved");
    expect(d.execution).toEqual({ kind: "order_lookup" });
  });

  it("escalates order status without an order id", () => {
    const d = decide({ ...base, category: "order_status" }, payload, ON);
    expect(d.status).toBe("escalated");
    expect(d.proposedAction).toMatch(/order number/i);
  });

  it("escalates negative high-urgency tickets regardless of category", () => {
    const d = decide(
      {
        ...base,
        category: "order_status",
        sentiment: "negative",
        urgency: "high",
      },
      { ...payload, orderId: "1042" },
      ON,
    );
    expect(d.status).toBe("escalated");
    expect(d.actionTaken).toBeNull();
  });

  it("always escalates complaints and uncategorized tickets", () => {
    expect(decide({ ...base, category: "complaint" }, payload, ON).status).toBe(
      "escalated",
    );
    expect(decide({ ...base, category: "other" }, payload, ON).status).toBe(
      "escalated",
    );
  });

  it("escalates store-dependent work when the store is not connected", () => {
    const OFF = { shopify: false, email: false };
    const order = decide({ ...base, category: "order_status" }, {
      ...payload,
      orderId: "1042",
    }, OFF);
    expect(order.status).toBe("escalated");
    expect(order.reason).toMatch(/not connected/);
    expect(order.execution).toBeNull();

    const refund = decide(
      { ...base, category: "refund", refundAmount: 20 },
      { ...payload, orderId: "1042" },
      OFF,
    );
    expect(refund.status).toBe("escalated");
    expect(refund.reason).toMatch(/not connected/);
  });
});
