# Verdict Row Inspector SDK

One small client package per language wrapping the Verdict Row x402
fleet's inspector surface: x402 payment handling, all the cheap
inspector routes, feed cursor management, and webhook signature
verification.

| Package | Language | Directory | Version | Status |
|---|---|---|---|---|
| `verdict-row-inspector` | Python | [`python/`](python/) | 0.1.0 | built + tested locally; PyPI upload pending (see repo notes) |
| `@quincygb/verdict-row-inspector` | TypeScript | [`typescript/`](typescript/) | 0.1.0 | **live on npm** (2026-10-31) |

Both packages implement the same surface and the same rules:

- **Paid routes** (StallRow unless noted): Recheck $0.005 ·
  Sign Reader / Score Book / Guard $0.01 each · Inspector Physical
  $0.05 · RouteVerdict check $0.05 · Recheck pack / Toolkit pack
  $1.00 · Fleet Pass $5 / $20 — prices verified against the live
  `/.well-known/x402` discovery documents on 2026-10-31.
- **Free reads**: the hash-chained Recheck feed v2 (since_seq
  cursor), verdict-read, pack/Fleet-Pass balances, watch and webhook
  registration (runs/subscriptions spend pack/pass funding).
- **Payment** via each ecosystem's real x402 client libraries
  (Python `x402` SDK; TS `@x402/fetch` + `@x402/core` + `@x402/evm`),
  EIP-3009 exact scheme on Base — never hand-rolled signing.
- **Spend guard**: a live 402 priced above a route's known price (or
  a caller-set ceiling) is refused before anything is signed.
- **Feed verification**: hash-chain continuity checked as the cursor
  walks; gaps/tampering raise an error.
- **Webhook verification**: HMAC-SHA256 (`X-Recheck-Signature`)
  accept/reject helper in both languages.

The API mirrors the fleet's Inspector Quickstart pages
(`/quickstart/python`, `/quickstart/typescript` on StallRow) so the
docs and the code agree. This SDK is distinct from `x402-guard`
(Python / `@quincygb/x402-guard`), the single-purpose pre-pay
wrapper: the Guard vets other people's endpoints; this SDK is the
client for the fleet's own inspector routes.

Contact: Ren, Verdict Row Patrol — patrol@verdictrow.com

Publishing is the owner's hand-step; see each package's README for
its install/development notes. Nothing in this repo is published yet.
