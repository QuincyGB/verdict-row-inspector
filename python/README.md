# verdict-row-inspector (Python)

The Inspector SDK for the **Verdict Row** x402 fleet: one async
Python client for StallRow's inspector surface and RouteVerdict —
discover-free reads, the cheap paid routes, prepaid packs and Fleet
Passes, the hash-chained change feed, watches and signed webhooks.

Contact: **Ren, Verdict Row Patrol — patrol@verdictrow.com**

> **Status: not yet published.** This package is built and tested
> locally; it is **not on PyPI yet**. Until the owner publishes it,
> install it from a local checkout:
>
> ```bash
> pip install ./inspector-sdk/python
> ```
>
> After publication the install will be
> `pip install verdict-row-inspector`.

This is the full inspector client. It is a different package from
`x402-guard` (a single-purpose pre-pay wrapper / payment-path
seatbelt): the Guard vets *other people's* endpoints before you pay
them; this SDK *is* the client for the fleet's own inspector routes.

## Quickstart

The API mirrors the fleet's Inspector Quickstart
(<https://stall-row-production.up.railway.app/quickstart/python>) —
same flow, packaged:

```python
import asyncio, os
from verdict_row_inspector import InspectorClient

async def main() -> None:
    # Signer from X402_PRIVATE_KEY (or AGENT_PRIVATE_KEY /
    # AGENT_KEY_FILE). Omit the signer and the free reads still work;
    # paid calls then raise PaymentRequiredError with the challenge.
    client = InspectorClient.from_env()

    target = "https://token-verdict-production.up.railway.app/v1/verdict"

    # Pin: one paid Recheck ($0.005) + one RouteVerdict check ($0.05).
    recheck = await client.recheck(target, watch_id="my-pin")
    route = await client.route_verdict(target)

    # The $0.01 toolkit trio + the $0.05 Inspector Physical.
    sign = await client.sign_read(target)
    book = await client.score_book(url=target)
    guard = await client.guard(target)
    physical = await client.physical(target)

    # Free recorded-state read — never probes or pays the target.
    recorded = await client.verdict_read(target)

    # Feed v2 (free): cursor-managed, hash-chain verified as it walks.
    async for env in client.feed():
        if env.record["status"] == "CHANGED":
            print("CHANGED", env.record["url"], env.record.get("field_changes"))
    print("resume from", client.feed_cursor.to_dict())

asyncio.run(main())
```

Payments are x402 v2, exact scheme, USDC on Base
(`eip155:8453`, asset `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`,
fleet payTo `0x097f9685D1e0752bF8B02d61E5Ce9be7eA0FBA7F`). The
authorization is gasless EIP-3009 — your wallet needs USDC on Base;
use a dedicated small-balance agent wallet.

## How payment works

Payment is handled by the installed Python **x402 SDK** — the same
library the fleet's own services run (stall-row pins `x402==2.25.0`):
an `x402Client` with `ExactEvmScheme` over an httpx transport from
`x402.http.clients` (the transport form of `wrapHttpxWithPayment`).
The SDK builds and EIP-712-signs the EIP-3009 authorization; this
package never hand-rolls signing.

**Spend guard.** The x402 client's payment-requirements selector is
the guard: before each paid call the client records the route's cap
— its known price from the table below, lowered by your
`max_amount_units=` ceiling when set. A live 402 asking more than
the cap raises `SpendGuardError` *before* any payload is signed.

## Packs, passes, batch, standing pushes

```python
pack = await client.buy_recheck_pack(target)        # $1.00, 250 checks / 90d
spent = await client.recheck(target, pack_id=pack["pack_id"])
bal = await client.recheck_pack_balance(pack["pack_id"])   # free

toolkit = await client.buy_toolkit_pack()           # $1.00 of trio credits
trio = await client.sign_read(target, pack_id=toolkit["pack_id"])

fleet = await client.buy_fleet_pass(20)             # or buy_fleet_pass(5)
balance = await client.pass_balance(fleet["pass_id"])      # free
batch = await client.batch_recheck([url1, url2], fleet["pass_id"])

watch = await client.watch_register(target, "https://you/hooks",
                                    interval_s=3600, pack_id=pack["pack_id"])
hook = await client.webhook_register("https://you/hooks", HOOK_SECRET,
                                     url=target, pack_id=pack["pack_id"])
```

Webhook deliveries arrive with `X-Recheck-Signature: sha256=<hex>`
(HMAC-SHA256 over the raw body, keyed with your secret). Verify:

```python
from verdict_row_inspector import verify_webhook_signature
ok = verify_webhook_signature(HOOK_SECRET, raw_body_bytes,
                              request.headers["x-recheck-signature"])
```

An exhausted pack returns 402 — there is never a silent per-call
fallback.

## Fleet Check (Framework Pack)

Whole-fleet health sweeps, packaged for framework runners:

```python
fc = await client.buy_fleet_check_pack(origins=["https://stall.example.com"])  # $5.00, 100 sweeps / 90d
run = await client.run_fleet_check_sweep(fc["pack_id"])     # one pack credit
status = await client.fleet_check_status(fc["pack_id"])     # free
once = await client.fleet_check_sweep(resources=[url])      # $0.10 single sweep

from verdict_row_inspector import framework_log_lines
for line in framework_log_lines(run):   # framework run-log lines
    print(line)
```

Every Fleet Check delivery carries `framework_log` entries (tool,
resource, verdict OK/DEGRADED/DOWN, defect, one-line message);
`framework_log_entries()` returns them structured. Pack deliveries
also carry `renewal` terms. Descriptor:
https://verdictrow.com/fleet-check-framework-pack.json

## Function-calling schema pack

Drop-in LLM tool definitions for every fleet route priced $0.05 or
less (24 tools), in OpenAI and Anthropic formats — generated from
the fleet's canonical route registry, and also served at
https://verdictrow.com/function-tools.json:

```python
from verdict_row_inspector import OPENAI_TOOLS, ANTHROPIC_TOOLS, get_function_tool

# OpenAI: pass OPENAI_TOOLS as the `tools` argument.
# Anthropic: pass ANTHROPIC_TOOLS as the `tools` argument.
tool = get_function_tool("stall_row_recheck", "openai")
```

Each tool is a paid POST endpoint on the x402 exact scheme (USDC on
Base): an unpaid call returns HTTP 402 with the payment challenge.
The definitions describe the tools; the payment leg is your x402
client's.

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
python -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/pytest
```

All tests are offline: mock transports replay challenges and
responses in the services' real shapes, and the signer is a
throwaway account generated at test time. Nothing is spent.

## License

MIT
