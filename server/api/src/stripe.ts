// Stripe integration — donations, the self-hosted way (docs/STUDIO.md).
//
// The self-hoster brings their OWN Stripe account: STRIPE_SECRET_KEY +
// STRIPE_WEBHOOK_SECRET in deploy.env, money lands in their account, no
// platform cut. We use Stripe Checkout (their hosted payment page), so card
// data never touches this process — our PCI surface is zero.
//
// Deliberately no `stripe` npm dependency: we need exactly two things — create
// a Checkout Session (one form-encoded POST) and verify a webhook signature
// (one HMAC) — both specified in Stripe's docs and stable for years.

import { createHmac, timingSafeEqual } from "node:crypto";

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  currency: string;
  minCents: number;
  /** Donations at/above this may attach a mediashare link. */
  mediaMinCents: number;
  /** Where Checkout returns the donor (the brand's /donate page). */
  publicWebOrigin: string;
}

export interface CheckoutRequest {
  donor: string;
  message: string;
  amountCents: number;
  mediaUrl?: string;
}

export function stripeEnabled(cfg: StripeConfig): boolean {
  return !!cfg.secretKey && !!cfg.webhookSecret;
}

/** Create a Checkout Session; returns the hosted payment URL. */
export async function createCheckout(
  cfg: StripeConfig,
  req: CheckoutRequest,
): Promise<string> {
  const params = new URLSearchParams({
    mode: "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": cfg.currency,
    "line_items[0][price_data][unit_amount]": String(req.amountCents),
    "line_items[0][price_data][product_data][name]": "Donation",
    success_url: `${cfg.publicWebOrigin}/donate?thanks=1`,
    cancel_url: `${cfg.publicWebOrigin}/donate?cancelled=1`,
    "metadata[donor]": req.donor.slice(0, 100),
    "metadata[message]": req.message.slice(0, 450), // Stripe metadata cap: 500
    submit_type: "donate",
  });
  if (req.mediaUrl) params.set("metadata[mediaUrl]", req.mediaUrl.slice(0, 450));

  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${cfg.secretKey}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  const body = (await res.json()) as { url?: string; error?: { message?: string } };
  if (!res.ok || !body.url) {
    throw new Error(body.error?.message ?? `Stripe error ${res.status}`);
  }
  return body.url;
}

/** Verify a `Stripe-Signature` header against the raw body. Returns the parsed
    event on success, null on any mismatch (never throw on attacker input). */
export function verifyWebhook(
  rawBody: string,
  signatureHeader: string | undefined,
  webhookSecret: string,
  toleranceSec = 300,
  nowSec = Math.floor(Date.now() / 1000),
): StripeEvent | null {
  if (!signatureHeader) return null;
  const parts = new Map<string, string[]>();
  for (const pair of signatureHeader.split(",")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const k = pair.slice(0, eq).trim();
    const v = pair.slice(eq + 1).trim();
    parts.set(k, [...(parts.get(k) ?? []), v]);
  }
  const t = parts.get("t")?.[0];
  const sigs = parts.get("v1") ?? [];
  if (!t || sigs.length === 0) return null;
  if (Math.abs(nowSec - Number(t)) > toleranceSec) return null;

  const expected = createHmac("sha256", webhookSecret)
    .update(`${t}.${rawBody}`)
    .digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const ok = sigs.some((s) => {
    const buf = Buffer.from(s, "utf8");
    return buf.length === expectedBuf.length && timingSafeEqual(buf, expectedBuf);
  });
  if (!ok) return null;

  try {
    return JSON.parse(rawBody) as StripeEvent;
  } catch {
    return null;
  }
}

export interface StripeEvent {
  type: string;
  data: {
    object: {
      id: string;
      amount_total?: number;
      currency?: string;
      metadata?: Record<string, string>;
    };
  };
}
