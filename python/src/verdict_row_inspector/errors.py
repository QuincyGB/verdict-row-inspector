"""Errors raised by the Inspector SDK."""

from __future__ import annotations

from typing import Any


class InspectorError(Exception):
    """Non-payment failure from a fleet service (HTTP status + body)."""

    def __init__(self, status: int, detail: Any):
        super().__init__(f"inspector request failed: HTTP {status}: {detail}")
        self.status = status
        self.detail = detail


class PaymentRequiredError(Exception):
    """The endpoint demands payment and this client could/did not pay.

    Carries the full parsed 402 challenge so callers can inspect or
    settle it themselves. Raised when no signer is configured, or when
    a paid retry still returns 402.
    """

    def __init__(self, challenge: dict, reason: str):
        super().__init__(reason)
        self.challenge = challenge
        self.reason = reason

    def structured_error(self) -> dict:
        return {
            "error": "payment_required",
            "reason": self.reason,
            "x402Version": self.challenge.get("x402Version"),
            "resource": self.challenge.get("resource"),
            "accepts": self.challenge.get("accepts"),
            "extensions": self.challenge.get("extensions"),
            "hint": (
                "Verdict Row inspector routes are priced per call in USDC "
                "on Base (x402) — see the route's accepts entry for the "
                "exact price. Configure a signer (private_key=..., "
                "X402_PRIVATE_KEY or AGENT_PRIVATE_KEY / AGENT_KEY_FILE) "
                "with an EVM wallet holding USDC on Base and the call "
                "will be paid automatically."
            ),
        }


class SpendGuardError(PaymentRequiredError):
    """The live 402 amount exceeds the route's known price and/or the
    caller-set ceiling. Raised BEFORE anything is signed — the payment
    payload is never created, so no authorization exists to settle."""


class FeedChainError(ValueError):
    """The Recheck feed v2 chain does not verify: a seq gap in an
    unfiltered walk, a prev_hash that does not link to the previous
    envelope's record_hash, a record_id that does not derive from its
    record_hash, or a record_hash that does not recompute from
    (prev_hash, record)."""
