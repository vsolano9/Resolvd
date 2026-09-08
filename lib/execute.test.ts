import { describe, expect, it, vi } from "vitest";
import {
  executeResolution,
  findOrderForRefund,
  sampleShopAdapter,
  type MailAdapter,
  type ShopAdapter,
  type ShopOrder,
} from "./execute";
import { displayStatus } from "./shopify";
import type { Decision } from "./policy";

const order: ShopOrder = {
  id: "1",
  name: "#1042",
  email: "sam@buyer.com",
  currency: "USD",
  total: "84.00",
  status: "shipped",
};

function shop(overrides: Partial<ShopAdapter> = {}): ShopAdapter {
  return {
    lookupByName: async () => order,
    lookupByEmail: async () => [order],
    createRefund: async () => ({ refundId: "r-1" }),
    ...overrides,
  };
}

const mail: MailAdapter = { sendReply: async () => {} };

function decision(kind: "order_lookup" | "refund", amount = 20): Decision {
  return {
    status: "resolved",
    proposedAction: "test",
    actionTaken: null,
    reason: "test",
    draftReply: "Thanks!",
    execution: kind === "refund" ? { kind, amount } : { kind },
  };
}

describe("displayStatus", () => {
  it("maps store state to human status", () => {
    expect(displayStatus({ cancelled_at: "2024-01-01" })).toBe("cancelled");
    expect(displayStatus({ financial_status: "refunded" })).toBe("refunded");
    expect(displayStatus({ fulfillment_status: "fulfilled" })).toBe("shipped");
    expect(displayStatus({ fulfillment_status: "partial" })).toBe("partially shipped");
    expect(displayStatus({})).toBe("processing");
  });
});

describe("findOrderForRefund", () => {
  it("prefers an explicit order reference", async () => {
    const found = await findOrderForRefund(shop(), "#1042", "nobody@x.com");
    expect(found.ok).toBe(true);
  });

  it("escalates when the reference matches nothing", async () => {
    const found = await findOrderForRefund(
      shop({ lookupByName: async () => null }),
      "#9999",
      "sam@buyer.com",
    );
    expect(found.ok).toBe(false);
  });

  it("escalates when the explicit reference lookup fails", async () => {
    const found = await findOrderForRefund(
      shop({
        lookupByName: async () => {
          throw new Error("shop unavailable");
        },
      }),
      "#1042",
      "sam@buyer.com",
    );
    expect(found.ok).toBe(false);
    if (!found.ok) expect(found.reason).toMatch(/order lookup failed: shop unavailable/);
  });

  it("uses a lone email match, refuses ambiguity", async () => {
    const lone = await findOrderForRefund(
      shop({ lookupByEmail: async () => [order] }),
      null,
      "sam@buyer.com",
    );
    expect(lone.ok).toBe(true);

    const many = await findOrderForRefund(
      shop({ lookupByEmail: async () => [order, { ...order, id: "2" }] }),
      null,
      "sam@buyer.com",
    );
    expect(many.ok).toBe(false);
    if (!many.ok) expect(many.reason).toMatch(/multiple/);
  });

  it("escalates when no order matches the sender", async () => {
    const found = await findOrderForRefund(
      shop({ lookupByEmail: async () => [] }),
      null,
      "ghost@x.com",
    );
    expect(found.ok).toBe(false);
  });
});

describe("executeResolution", () => {
  it("resolves order lookups with the live status", async () => {
    const r = await executeResolution(
      decision("order_lookup"),
      { sender: "sam@buyer.com", subject: "Where?", orderRef: "1042" },
      shop(),
      mail,
      false,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.actionTaken).toMatch(/shipped/);
      expect(r.actionTaken).toMatch(/#1042/);
      expect(r.actionTaken).not.toMatch(/Sample store/);
    }
  });

  it("escalates order lookups that miss", async () => {
    const r = await executeResolution(
      decision("order_lookup"),
      { sender: "sam@buyer.com", subject: "Where?", orderRef: "#0000" },
      shop({ lookupByName: async () => null }),
      mail,
      false,
    );
    expect(r.ok).toBe(false);
  });

  it("executes refunds and reports the refund id", async () => {
    const sendReply = vi.fn(async () => {});
    const createRefund = vi.fn(async () => ({ refundId: "r-99" }));
    const r = await executeResolution(
      decision("refund", 20),
      { sender: "sam@buyer.com", subject: "Refund", orderRef: "1042" },
      shop({ createRefund }),
      { sendReply },
      false,
    );
    expect(r.ok).toBe(true);
    expect(createRefund).toHaveBeenCalledWith("1", 20, "USD");
    expect(sendReply).toHaveBeenCalledOnce();
    if (r.ok) expect(r.actionTaken).toMatch(/r-99/);
  });

  it("skips email when no mailer is configured", async () => {
    const sendReply = vi.fn(async () => {});
    const r = await executeResolution(
      decision("order_lookup"),
      { sender: "sam@buyer.com", subject: "Where?", orderRef: "1042" },
      shop(),
      null,
      false,
    );
    expect(r.ok).toBe(true);
    expect(sendReply).not.toHaveBeenCalled();
    if (r.ok) expect(r.actionTaken).toMatch(/draft saved/);
  });

  it("flips to escalation when the store call throws", async () => {
    const r = await executeResolution(
      decision("order_lookup"),
      { sender: "sam@buyer.com", subject: "Where?", orderRef: "1042" },
      shop({
        lookupByName: async () => {
          throw new Error("boom");
        },
      }),
      mail,
      false,
    );
    expect(r.ok).toBe(false);
  });

  it("labels sample-store resolutions", async () => {
    const r = await executeResolution(
      decision("order_lookup"),
      { sender: "sam@buyer.com", subject: "Where?", orderRef: "1042" },
      sampleShopAdapter(),
      null,
      true,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.actionTaken).toMatch(/Sample store/);
  });

  it("sample store resolves the demo refund by sender email", async () => {
    const r = await executeResolution(
      decision("refund", 18),
      { sender: "jo@buyer.com", subject: "Refund", orderRef: null },
      sampleShopAdapter(),
      null,
      true,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.actionTaken).toMatch(/sample-9002/);
  });
});
