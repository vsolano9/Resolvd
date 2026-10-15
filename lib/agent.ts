import type { Category, Sentiment, Triage, Urgency } from "./types";

// Triage a ticket. Uses Claude when ANTHROPIC_API_KEY is set; otherwise a
// transparent keyword heuristic so the service works without a key.
export async function triage(
  subject: string,
  body: string,
): Promise<Triage> {
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      return await triageWithClaude(subject, body);
    } catch (e) {
      console.error("[resolvd] Claude triage failed, falling back:", e);
    }
  }
  return heuristicTriage(subject, body);
}

async function triageWithClaude(
  subject: string,
  body: string,
): Promise<Triage> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY as string,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 700,
      system:
        "You triage ecommerce support tickets. Reply ONLY with JSON: " +
        '{"category":"order_status|refund|complaint|other","urgency":"low|normal|high",' +
        '"sentiment":"positive|neutral|negative","refundAmount":number|null,' +
        '"summary":"one line","draftReply":"a polite, on-brand reply"}',
      messages: [
        { role: "user", content: `Subject: ${subject}\n\n${body}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}`);
  const data = (await res.json()) as {
    content: Array<{ type: string; text?: string }>;
  };
  const text = data.content.find((c) => c.type === "text")?.text ?? "{}";
  const parsed = JSON.parse(
    text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim(),
  );
  return {
    category: parsed.category ?? "other",
    urgency: parsed.urgency ?? "normal",
    sentiment: parsed.sentiment ?? "neutral",
    refundAmount:
      Number.isFinite(parsed.refundAmount) ? parsed.refundAmount : undefined,
    summary: parsed.summary ?? "",
    draftReply: parsed.draftReply ?? "",
  };
}

function heuristicTriage(subject: string, body: string): Triage {
  const t = `${subject} ${body}`.toLowerCase();
  let category: Category = "other";
  if (/\brefund|money back|chargeback\b/.test(t)) category = "refund";
  else if (/\bwhere|track|status|arriv|deliver|shipp?ed\b/.test(t))
    category = "order_status";
  else if (/\bbroken|terrible|awful|angry|worst|complain\b/.test(t))
    category = "complaint";

  const sentiment: Sentiment = /\b(angry|terrible|awful|worst|furious|scam)\b/.test(
    t,
  )
    ? "negative"
    : /\b(thanks|great|love|appreciate)\b/.test(t)
      ? "positive"
      : "neutral";

  const urgency: Urgency =
    sentiment === "negative" || /\burgent|asap|immediately\b/.test(t)
      ? "high"
      : "normal";

  const amountMatch = body.match(/\$\s?(\d+(?:\.\d{1,2})?)/);
  const refundAmount = amountMatch ? parseFloat(amountMatch[1]) : undefined;

  return {
    category,
    urgency,
    sentiment,
    refundAmount,
    summary: subject || body.slice(0, 80),
    draftReply:
      "Thanks for reaching out, we're looking into this and will follow up shortly.",
  };
}
