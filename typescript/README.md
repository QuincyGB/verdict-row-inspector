# @quincygb/verdict-row-inspector (TypeScript)

The Inspector SDK for the **Verdict Row** x402 fleet: one async
TypeScript client for StallRow's inspector surface and RouteVerdict —
the cheap paid routes, prepaid packs and Fleet Passes, the
hash-chained change feed, watches and signed webhooks, with typed
responses.

Contact: **Ren, Verdict Row Patrol — patrol@verdictrow.com**

> **Status: not yet published.** This package is built and tested
> locally; it is **not on npm yet**. Until the owner publishes it,
> install it from a local checkout:
>
> ```bash
> npm install ./inspector-sdk/typescript
> ```
>
> After publication the install will be
> `npm install @quincygb/verdict-row-inspector`.

This is the full inspector client. It is a different package from
`@quincygb/x402-guard` (a single-purpose pre-pay wrapper /
payment-path seatbelt): the Guard vets *other people's* endpoints
before you pay them; this SDK *is* the client for the fleet's own
inspector routes.

## Quickstart

The API mirrors the fleet's Inspector Quickstart
(<https://stall-row-production.up.railway.app/quickstart/typescript>) —
same flow, packaged:

```ts
import { InspectorClient } from "@quincygb/verdict-row-inspector";
import { privateKeyToAccount } from "viem/accounts";

const signer = privateKeyToAccount(process.env.X402_PRIVATE_KEY as `0x${string}`);
const client = new InspectorClient({ signer }); // signer optional: free reads work without one

const target = "https://token-verdict-production.up.railway.app/v1/verdict";

// Pin: one paid Recheck ($0.005) + one RouteVerdict check ($0.05).
const recheck = await client.recheck(target, { watchId: "my-pin" });
const route = await client.routeVerdict(target);

// The $0.01 toolkit trio + the $0.05 Inspector Physical.
await client.signRead(target);
await client.scoreBook({ url: target });
await client.guard(target);
await client.physical(target);

// Free recorded-state read — never probes or pays the target.
const recorded = await client.verdictRead(target);

// Feed v2 (free): cursor-managed, hash-chain verified as it walks.
for await (const env of client.feed()) {
  if (env.record.status === "CHANGED")
    console.log("CHANGED", env.record.url, env.record.field_changes);
}
console.log("resume from", client.feedCursor);
```

Payments are x402 v2, exact scheme, USDC on Base
(`eip155:8453`, asset `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`,
fleet payTo `0x097f9685D1e0752bF8B02d61E5Ce9be7eA0FBA7F`). The
authorization is gasless EIP-3009 — your wallet needs USDC on Base;
use a dedicated small-balance agent wallet.

## How payment works

Payment is handled by the ecosystem's standard x402 client packages
— `@x402/fetch` (`wrapFetchWithPayment`), `@x402/core` (`x402Client`)
and `@x402/evm` (`ExactEvmScheme`) — the same stack the quickstart
uses. The scheme builds and signs the EIP-3009 authorization; this
package never hand-rolls signing.

**Spend guard.** The x402 client's payment-requirements selector is
the guard: before each paid call the client records the route's cap
— its known price from the table below, lowered by your
`maxAmountUnits` ceiling when set. A live 402 asking more than the
cap throws `SpendGuardError` *before* any payload is signed.

## Packs, passes, batch, standing pushes

```ts
const pack = await client.buyRecheckPack(target);          // $1.00, 250 checks / 90d
await client.recheck(target, { packId: pack.pack_id });
await client.recheckPackBalance(pack.pack_id!);            // free

const toolkit = await client.buyToolkitPack();             // $1.00 of trio credits
await client.signRead(target, { packId: toolkit.pack_id });

const fleet = await client.buyFleetPass(20);               // or buyFleetPass(5)
await client.passBalance(fleet.pass_id!);                  // free
await client.batchRecheck([url1, url2], fleet.pass_id!);

await client.watchRegister(target, {
  webhookUrl: "https://you/hooks", intervalS: 3600, packId: pack.pack_id,
});
await client.webhookRegister("https://you/hooks", HOOK_SECRET, {
  url: target, packId: pack.pack_id,
});
```

Webhook deliveries arrive with `X-Recheck-Signature: sha256=<hex>`
(HMAC-SHA256 over the raw body, keyed with your secret). Verify with
`verifyWebhookSignature(secret, rawBody, header)` from this package
(node:crypto, constant-time compare).

An exhausted pack returns 402 — there is never a silent per-call
fallback.

## Routes and prices

Verified against the live `/.well-known/x402` discovery documents of
both stalls on 2026-10-31:

| Method | Route | Price |
|---|---|---|
| POST | StallRow `/v1/recheck` | $0.005 |
| POST | StallRow `/v1/sign-read` | $0.01 |
| POST | StallRow `/v1/score-book` | $0.01 |
| POST | StallRow `/v1/guard` | $0.01 |
| POST | StallRow `/v1/physical` | $0.05 |
| POST | RouteVerdict `/v1/check` | $0.05 |
| POST | StallRow `/v1/recheck/pack` | $1.00 |
| POST | StallRow `/v1/toolkit/pack` | $1.00 |
| POST | StallRow `/v1/fleet-pass` | $5.00 |
| POST | StallRow `/v1/fleet-pass-20` | $20.00 |
| POST | StallRow `/v1/recheck/batch` | Fleet-Pass-funded ($0.005/check, debited once; 20% off at exactly 100 unique URLs) |
| POST | StallRow `/v1/fleet-pass/balance` | free (holder read) |
| GET | StallRow `/v1/recheck/feed?v=2` | free (since_seq cursor, origin/pay_to/route filters) |
| GET | StallRow `/v1/verdict-read` | free (recorded state) |
| POST | StallRow `/v1/watch/register` | free to register (runs spend pack/pass funding) |
| POST | StallRow `/v1/recheck/webhooks` | free to register (pack/pass gated) |

## Development

```bash
npm install
npm run typecheck
npm test        # vitest, fully offline (injected mock fetch)
npm run build   # tsup -> dist (esm + cjs + d.ts)
```

All tests are offline: an injected mock fetch replays challenges and
responses in the services' real shapes, and the signer is a
throwaway viem account generated at test time. Nothing is spent.

## License

MIT
