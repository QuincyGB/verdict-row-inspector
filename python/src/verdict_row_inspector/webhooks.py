"""Webhook signature verification for Verdict Row change pushes.

Recheck change events (per-watch webhooks and the self-serve
/v1/recheck/webhooks subscriptions) are delivered as JSON with the
header:

    X-Recheck-Signature: sha256=<hex>

where <hex> is HMAC-SHA256 over the EXACT raw request body bytes,
keyed with the subscription secret (stall-row
app/services/recheck.py deliver_change_event: body is
json.dumps(payload, sort_keys=True), signature is
hmac.new(secret.encode(), body, sha256).hexdigest()).

Verify against the raw bytes you received — never a re-serialized
parse of the JSON, or key order/whitespace differences will (rightly)
fail the check.
"""

from __future__ import annotations

import hashlib
import hmac

SIGNATURE_HEADER = "x-recheck-signature"
EVENT_ID_HEADER = "x-recheck-event-id"


def compute_signature(secret: str, body: bytes | str) -> str:
    """The full header value (`sha256=<hex>`) for a body + secret."""
    raw = body.encode("utf-8") if isinstance(body, str) else body
    digest = hmac.new(secret.encode("utf-8"), raw, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


def verify_signature(secret: str, body: bytes | str, signature: str | None) -> bool:
    """Constant-time check of an X-Recheck-Signature header value.

    Accepts the header with or without the `sha256=` prefix. Returns
    False (never raises) for a missing or malformed signature.
    """
    if not signature:
        return False
    presented = signature.strip()
    if presented.startswith("sha256="):
        presented = presented[len("sha256="):]
    raw = body.encode("utf-8") if isinstance(body, str) else body
    expected = hmac.new(secret.encode("utf-8"), raw, hashlib.sha256).hexdigest()
    return hmac.compare_digest(presented, expected)
