/**
 * Inspector SDK tests. ALL payments are mocked — fetch is injected
 * and the signer is a throwaway viem account generated at test time.
 * No test touches the network or spends anything.
 *
 * Fixture provenance mirrors the Python suite: the 402 challenge
 * shape is the real production challenge captured in
 * stall-row-mcp/tests/fixtures/payment_required.json (2026-10-27)
 * with resource/amount set to the route under test; feed envelopes
 * are generated with the service's own chain rule (stall-row
 * app/services/recheck.py); the webhook expectation is computed as
 * the service's delivery code and stall-row/tests/test_hooksubs.py
 * compute it (HMAC-SHA256 over the raw body, `sha256=<hex>` header).
 */

import { createHash, createHmac } from "node:crypto";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import {
    InspectorClient,
    PaymentRequiredError,
    ROUTE_PRICES,
    SpendGuardError,
    chainHash,
    verifyWebhookSignature,
    type FeedEnvelope,
} from "./index";

const STALL = "https://stall.test";
const ROUTE = "https://route.test";
const TARGET = "https://token-verdict-production.up.railway.app/v1/verdict";
const PAY_TO = "0x097f9685D1e0752bF8B02d61E5Ce9be7eA0FBA7F";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const signer = privateKeyToAccount(generatePrivateKey());

function challenge(amount: string, path: string, base = STALL): Record<string, unknown> {
    return {
        x402Version: 2,
        error: "Payment required",
        resource: { url: `${base}${path}`, description: "inspector route", mimeType: "application/json", serviceName: "stall-row" },
        accepts: [
            {
                scheme: "exact",
                network: "eip155:8453",
                asset: USDC,
                amount,
                payTo: PAY_TO,
                maxTimeoutSeconds: 300,
                extra: { name: "USD Coin", version: "2" },
            },
        ],
    };
}

function challengeResponse(ch: Record<string, unknown>): Response {
    const header = Buffer.from(JSON.stringify(ch)).toString("base64");
    return new Response("{}", {
        status: 402,
        headers: { "payment-required": header, "content-type": "application/json" },
    });
}

interface SeenRequest {
    url: string;
    headers: Headers;
    body: unknown;
}

function mockFetch(handler: (req: SeenRequest) => Response | Promise<Response>) {
    const seen: SeenRequest[] = [];
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
        // @x402/fetch passes a Request object on the paid retry.
        const isRequest = typeof input === "object" && input !== null && "url" in input;
        const req: SeenRequest = {
            url: isRequest ? (input as Request).url : String(input),
            headers: new Headers(
                init?.headers ?? (isRequest ? (input as Request).headers : undefined),
            ),
            body: init?.body ? JSON.parse(String(init.body)) : undefined,
        };
        seen.push(req);
        return handler(req);
    }) as unknown as typeof fetch;
    return { fetchImpl, seen };
}

function paidHandler(result: Record<string, unknown>, amountFor?: (path: string) => string) {
    return (req: SeenRequest) => {
        if (!req.headers.get("payment-signature")) {
            const u = new URL(req.url);
            const base = u.host === "route.test" ? ROUTE : STALL;
            const amount = amountFor
                ? amountFor(u.pathname)
                : String(ROUTE_PRICES[u.pathname] ?? 50_000);
            return challengeResponse(challenge(amount, u.pathname, base));
        }
        const receipt = Buffer.from(
            JSON.stringify({ success: true, transaction: "0x" + "ab".repeat(32), network: "eip155:8453", payer: signer.address }),
        ).toString("base64");
        return new Response(JSON.stringify(result), {
            status: 200,
            headers: { "content-type": "application/json", "payment-response": receipt },
        });
    };
}

function makeClient(fetchImpl: typeof fetch, opts: Record<string, unknown> = {}) {
    return new InspectorClient({
        signer,
        stallRowUrl: STALL,
        routeVerdictUrl: ROUTE,
        fetchImpl,
        ...opts,
    });
}

describe("prices", () => {
    it("match live discovery (2026-10-31)", () => {
        expect(ROUTE_PRICES["/v1/recheck"]).toBe(5_000);
        expect(ROUTE_PRICES["/v1/sign-read"]).toBe(10_000);
        expect(ROUTE_PRICES["/v1/physical"]).toBe(50_000);
        expect(ROUTE_PRICES["/v1/fleet-pass-20"]).toBe(20_000_000);
    });
});

describe("payment flow", () => {
    it("signs an EIP-3009 payload and retries on Recheck", async () => {
        const { fetchImpl, seen } = mockFetch(paidHandler({ status: "BASELINE", url: TARGET }));
        const client = makeClient(fetchImpl);
        const result = await client.recheck(TARGET);
        expect(result.status).toBe("BASELINE");
        expect(seen).toHaveLength(2);
        expect(seen[0].headers.get("payment-signature")).toBeNull();
        const payload = JSON.parse(
            Buffer.from(seen[1].headers.get("payment-signature")!, "base64").toString("utf-8"),
        );
        expect(payload.accepted.amount).toBe("5000");
        expect(payload.payload.authorization.from).toBe(signer.address);
        expect(payload.payload.authorization.to).toBe(PAY_TO);
        expect(payload.payload.authorization.value).toBe("5000");
        expect(payload.payload.signature).toMatch(/^0x/);
        expect(client.lastReceipt?.success).toBe(true);
    });

    it("buys the $20 Fleet Pass above the SDK default $1 cap", async () => {
        const { fetchImpl, seen } = mockFetch(paidHandler({ pass_id: "pass_abc" }));
        const client = makeClient(fetchImpl);
        const result = await client.buyFleetPass(20);
        expect(result.pass_id).toBe("pass_abc");
        const payload = JSON.parse(
            Buffer.from(seen[1].headers.get("payment-signature")!, "base64").toString("utf-8"),
        );
        expect(payload.accepted.amount).toBe("20000000");
    });

    it("spends a pack credit without paying", async () => {
        const { fetchImpl, seen } = mockFetch(() =>
            new Response(JSON.stringify({ challenge_found: true }), {
                status: 200,
                headers: { "content-type": "application/json" },
            }),
        );
        const client = makeClient(fetchImpl);
        const result = await client.signRead(TARGET, { packId: "tpack_1" });
        expect(result.challenge_found).toBe(true);
        expect(seen).toHaveLength(1);
        expect(seen[0].headers.get("payment-signature")).toBeNull();
        expect((seen[0].body as Record<string, unknown>).pack_id).toBe("tpack_1");
    });
});

describe("spend guard", () => {
    it("refuses an overpriced challenge before signing", async () => {
        const { fetchImpl, seen } = mockFetch(() =>
            challengeResponse(challenge("6000", "/v1/recheck")),
        );
        const client = makeClient(fetchImpl);
        await expect(client.recheck(TARGET)).rejects.toBeInstanceOf(SpendGuardError);
        expect(seen).toHaveLength(1);
        expect(seen[0].headers.get("payment-signature")).toBeNull();
    });

    it("honours a caller ceiling below the route price", async () => {
        const { fetchImpl, seen } = mockFetch(paidHandler({ status: "BASELINE" }));
        const client = makeClient(fetchImpl, { maxAmountUnits: 4_000 });
        await expect(client.recheck(TARGET)).rejects.toBeInstanceOf(SpendGuardError);
        expect(seen.every((r) => !r.headers.get("payment-signature"))).toBe(true);
    });
});

describe("no signer", () => {
    it("raises a structured PaymentRequiredError on paid routes", async () => {
        const { fetchImpl } = mockFetch(() =>
            challengeResponse(challenge("5000", "/v1/recheck")),
        );
        const client = new InspectorClient({ stallRowUrl: STALL, routeVerdictUrl: ROUTE, fetchImpl });
        const err = await client.recheck(TARGET).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(PaymentRequiredError);
        const structured = (err as PaymentRequiredError).structuredError();
        expect(structured.error).toBe("payment_required");
        expect((structured.accepts as { amount: string }[])[0].amount).toBe("5000");
    });

    it("does free reads without a signer", async () => {
        const { fetchImpl } = mockFetch((req) => {
            if (req.url.includes("/v1/verdict-read")) {
                return new Response(JSON.stringify({ found: false, url: TARGET }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                });
            }
            return new Response(JSON.stringify({ pass_id: "pass_1", balance_units: 5_000_000 }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        });
        const client = new InspectorClient({ stallRowUrl: STALL, routeVerdictUrl: ROUTE, fetchImpl });
        expect((await client.verdictRead(TARGET)).found).toBe(false);
        expect((await client.passBalance("pass_1")).balance_units).toBe(5_000_000);
    });
});

// --- feed ---------------------------------------------------------------------

function makeRecord(seq: number): Record<string, unknown> {
    return {
        watch_id: "w",
        url: TARGET,
        kind: "x402",
        status: seq === 1 ? "BASELINE" : "UNCHANGED",
        changes: [],
        current: { amount: "5000", payTo: PAY_TO, network: "eip155:8453" },
        checked_at: `2026-10-31T00:00:0${seq}Z`,
    };
}

function makeEnvelopes(count: number): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    let prev = "genesis";
    for (let seq = 1; seq <= count; seq++) {
        const record = makeRecord(seq);
        const recordHash = chainHash(prev, record);
        out.push({
            seq,
            record_id: `rec_${recordHash.slice(0, 24)}`,
            schema_version: 1,
            prev_hash: prev,
            record_hash: recordHash,
            record,
        });
        prev = recordHash;
    }
    return out;
}

function feedFetch(envelopes: Record<string, unknown>[]) {
    return mockFetch((req) => {
        const u = new URL(req.url);
        const since = Number(u.searchParams.get("since_seq") ?? "0");
        const limit = Number(u.searchParams.get("limit") ?? "200");
        const page = envelopes.filter((e) => Number(e.seq) > since).slice(0, limit);
        return new Response(page.map((e) => JSON.stringify(e)).join("\n") + "\n", {
            status: 200,
            headers: {
                "content-type": "application/x-ndjson",
                "X-Recheck-Feed-Latest-Seq": String(Math.max(...envelopes.map((e) => Number(e.seq)))),
                "X-Recheck-Feed-Earliest-Seq": "1",
                "X-Recheck-Feed-Count": String(envelopes.length),
            },
        });
    });
}

describe("feed", () => {
    it("walks pages and advances the cursor", async () => {
        const envelopes = makeEnvelopes(3);
        const { fetchImpl } = feedFetch(envelopes);
        const client = new InspectorClient({ stallRowUrl: STALL, fetchImpl });
        const seen: FeedEnvelope[] = [];
        for await (const env of client.feed({ pageLimit: 2 })) seen.push(env);
        expect(seen.map((e) => e.seq)).toEqual([1, 2, 3]);
        expect(client.feedCursor.seq).toBe(3);
        expect(client.feedCursor.lastHash).toBe(envelopes[2].record_hash);
    });

    it("detects a seq gap in an unfiltered walk", async () => {
        const envelopes = makeEnvelopes(3).filter((e) => e.seq !== 2);
        const { fetchImpl } = feedFetch(envelopes);
        const client = new InspectorClient({ stallRowUrl: STALL, fetchImpl });
        await expect(async () => {
            for await (const _env of client.feed()) void _env;
        }).rejects.toThrow(/gap in the feed chain/);
    });

    it("detects a tampered record", async () => {
        const envelopes = makeEnvelopes(2);
        (envelopes[1].record as Record<string, unknown>).current = { amount: "999999" };
        const { fetchImpl } = feedFetch(envelopes);
        const client = new InspectorClient({ stallRowUrl: STALL, fetchImpl });
        await expect(client.feedPage(0)).rejects.toThrow(/does not recompute/);
    });

    it("allows seq gaps in a filtered view", async () => {
        const envelopes = makeEnvelopes(3).filter((e) => e.seq !== 2);
        const { fetchImpl } = feedFetch(envelopes);
        const client = new InspectorClient({ stallRowUrl: STALL, fetchImpl });
        const page = await client.feedPage(0, { origin: "https://token-verdict-production.up.railway.app" });
        expect(page.envelopes.map((e) => e.seq)).toEqual([1, 3]);
        expect(page.latestSeq).toBe(3);
    });
});

// --- webhooks --------------------------------------------------------------------

describe("webhooks", () => {
    it("verifies HMAC-SHA256 signatures accept/reject", () => {
        const secret = "test-secret-0123456789";
        const body = JSON.stringify({ event: "recheck.changed", seq: 7 });
        const expected = createHmac("sha256", secret).update(body).digest("hex");
        expect(verifyWebhookSignature(secret, body, `sha256=${expected}`)).toBe(true);
        expect(verifyWebhookSignature(secret, body, expected)).toBe(true);
        expect(verifyWebhookSignature("wrong-secret-0123456", body, `sha256=${expected}`)).toBe(false);
        expect(verifyWebhookSignature(secret, body + " ", `sha256=${expected}`)).toBe(false);
        expect(verifyWebhookSignature(secret, body, null)).toBe(false);
        // sanity: the sha256 helper agrees with node crypto on the chain rule input
        expect(createHash("sha256").update("genesis\n{}").digest("hex")).toBe(chainHash("genesis", {}));
    });

    it("registers a subscription with its funding credential", async () => {
        const { fetchImpl, seen } = mockFetch(() =>
            new Response(JSON.stringify({ subscription: { sub_id: "sub_1" } }), {
                status: 200,
                headers: { "content-type": "application/json" },
            }),
        );
        const client = new InspectorClient({ stallRowUrl: STALL, fetchImpl });
        const result = await client.webhookRegister("https://hooks.test/cb", "test-secret-0123456789", {
            url: TARGET,
            packId: "pack_1",
        });
        expect(result.subscription?.sub_id).toBe("sub_1");
        expect((seen[0].body as Record<string, unknown>).pack_id).toBe("pack_1");
    });
});
