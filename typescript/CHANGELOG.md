# Changelog

## 0.4.0 — 2026-11-04

- Fleet Check helper (Next-20 Item 13, Fleet Check Framework Packs):
  `InspectorClient.buyFleetCheckPack()` ($5.00 — 100 sweeps of one
  fixed fleet definition, 90-day expiry), `fleetCheckSweep()`
  ($0.10 single sweep), `runFleetCheckSweep(packId)` (one pack
  credit, no x402 payment) and `fleetCheckStatus(packId)` (free).
  Fleet Check prices join `ROUTE_PRICES`, so the per-route spend
  guard caps pack purchases at exactly $5.00. Every Fleet Check
  delivery carries the service's `framework_log` run-log entries;
  the exported `frameworkLogEntries(delivery)` /
  `frameworkLogLines(delivery)` helpers return them as structured
  entries or one-line strings a framework runner can log.
- Tests: 31 passing (7 new Fleet Check tests: price pins, mocked
  $5.00 pack purchase, $0.10 sweep, pack-credit run, free status,
  over-price challenge refused by the spend guard, log-helper
  tolerance). All offline, $0 spent.
- npm: prepared-only — the stored credential still returns 401 on
  whoami (confirmed repeatedly on 2026-11-04), so 0.4.0 is packed
  as a tarball and NOT published; publishing unblocks when the
  credential is fixed.

## 0.3.0 — 2026-11-04

- LangChain JS tools at the new `./langchain` entry point
  (`@quincygb/verdict-row-inspector/langchain`): `getLangChainTools(client)`
  returns one `DynamicStructuredTool` per Item-4 pack tool — the 24
  fleet routes priced $0.05 or less, generated from the embedded pack
  (names, price-carrying descriptions and zod schemas converted from
  the pack's own JSON schemas) — whose invoke performs the paid call
  through the client's existing x402 payment stack via the new
  `InspectorClient.callPackRoute(route, args)` (per-route spend guard
  capped at the pack price). Plus `stall_row_recheck_feed`, a FREE
  tool that reads the Recheck feed v2 through the client's
  cursor-managed, hash-chain-verifying feed walk. `@langchain/core`
  and `zod` are optional peer dependencies; the main entry imports
  neither. CrewAI has no TypeScript channel — the CrewAI surface is
  the Python `verdict-row-crewai` package (verdict-row-adapters repo).
- Client: `tokenVerdictUrl` option + `DEFAULT_TOKEN_VERDICT_URL`
  (the pack's Token Verdict routes previously had no client home).
- Tests: 24 passing (6 new LangChain tests: inventory pinned to the
  pack, schema fidelity, mocked paid invokes on two stalls, feed
  cursor walk + tampered-chain rejection). All offline, $0 spent.
- npm: prepared-only — the stored credential still returns 401 on
  whoami (checked 2026-11-04), so 0.3.0 is packed as a tarball and
  NOT published; publishing unblocks when the credential is fixed.

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
