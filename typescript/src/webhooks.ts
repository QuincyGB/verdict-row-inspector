/**
 * Webhook signature verification for Verdict Row change pushes.
 *
 * Recheck change events are delivered as JSON with the header
 * `X-Recheck-Signature: sha256=<hex>`, where <hex> is HMAC-SHA256
 * over the EXACT raw request body bytes, keyed with the subscription
 * secret (stall-row app/services/recheck.py deliver_change_event).
 *
 * Verify against the raw bytes you received — never a re-serialized
 * parse of the JSON.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-recheck-signature";
export const EVENT_ID_HEADER = "x-recheck-event-id";

/** The full header value (`sha256=<hex>`) for a body + secret. */
export function computeWebhookSignature(
    secret: string,
    body: string | Uint8Array,
): string {
    const digest = createHmac("sha256", secret).update(body).digest("hex");
    return `sha256=${digest}`;
}

/** Constant-time check of an X-Recheck-Signature header value.
 * Accepts the header with or without the `sha256=` prefix. Returns
 * false (never throws) for a missing or malformed signature. */
export function verifyWebhookSignature(
    secret: string,
    body: string | Uint8Array,
    signature: string | null | undefined,
): boolean {
    if (!signature) return false;
    let presented = signature.trim();
    if (presented.startsWith("sha256=")) presented = presented.slice("sha256=".length);
    const expected = createHmac("sha256", secret).update(body).digest("hex");
    const a = Buffer.from(presented, "utf-8");
    const b = Buffer.from(expected, "utf-8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}
