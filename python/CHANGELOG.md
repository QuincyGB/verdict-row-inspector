# Changelog

## 0.1.0 — 2026-10-31

First local build (not yet published to PyPI).

- `InspectorClient`: async client for StallRow's inspector surface
  (Recheck, Sign Reader, Score Book, Guard, Inspector Physical),
  RouteVerdict checks, Recheck + toolkit packs, Fleet Pass ($5/$20)
  purchase and balance, Fleet-Pass-funded batch rechecks, and the
  free verdict-read.
- Payment via the installed Python x402 SDK (`x402Client` +
  `ExactEvmScheme`, EIP-3009 exact scheme on Base) with a per-route
  spend guard enforced in the payment-requirements selector —
  over-price challenges are refused before signing.
- Feed v2: cursor-managed generator with hash-chain verification
  (seq continuity + prev_hash linkage on unfiltered walks,
  per-envelope hash recomputation everywhere), origin/pay_to/route
  filters, and a persistable `FeedCursor`.
- Watch registration and self-serve change-webhook registration,
  plus `verify_webhook_signature` (HMAC-SHA256, `X-Recheck-Signature`).
- Fully offline test suite (mock transports, real fixture shapes).
