# Changelog

## 0.2.0 — 2026-11-04

- Function-calling schema pack: `FUNCTION_TOOLS_PACK`, `OPENAI_TOOLS`,
  `ANTHROPIC_TOOLS`, `FUNCTION_TOOL_ROUTES` and the typed
  `getFunctionTool(name, format)` helper — drop-in LLM tool
  definitions for every fleet route priced $0.05 or less (24 tools),
  generated from the fleet's canonical route registry by the
  fleet-checker's function_tools.py and also served at
  https://verdictrow.com/function-tools.json. New offline tests
  validate the pack against its embedded registry snapshot (unique
  names, prices in every description matching the snapshot, both
  formats carrying identical schemas).

## 0.1.0 — 2026-10-31

First local build (not yet published to npm).

- `InspectorClient`: async client for StallRow's inspector surface
  (Recheck, Sign Reader, Score Book, Guard, Inspector Physical),
  RouteVerdict checks, Recheck + toolkit packs, Fleet Pass ($5/$20)
  purchase and balance, Fleet-Pass-funded batch rechecks, and the
  free verdict-read — with typed responses.
- Payment via the standard x402 client packages (@x402/fetch
  `wrapFetchWithPayment`, @x402/core `x402Client`, @x402/evm
  `ExactEvmScheme`, EIP-3009 exact scheme on Base) with a per-route
  spend guard enforced in the payment-requirements selector —
  over-price challenges are refused before signing.
- Feed v2: cursor-managed async generator with hash-chain
  verification (seq continuity + prev_hash linkage on unfiltered
  walks, per-envelope hash recomputation everywhere, canonical JSON
  matching the service's Python chain rule), origin/pay_to/route
  filters, and a persistable cursor.
- Watch registration and self-serve change-webhook registration,
  plus `verifyWebhookSignature` (HMAC-SHA256, `X-Recheck-Signature`,
  node:crypto constant-time compare).
- Fully offline test suite (injected mock fetch, real fixture shapes).
