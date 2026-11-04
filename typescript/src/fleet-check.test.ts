/**
 * Fleet Check helper tests (Next-20 Item 13: Fleet Check Framework
 * Packs). ALL payments are mocked — fetch is injected and the signer
 * is a throwaway viem account generated at test time. No test
 * touches the network or spends anything.
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import {
    InspectorClient,
    ROUTE_PRICES,
    SpendGuardError,
    frameworkLogEntries,
    frameworkLogLines,
    type FrameworkLogEntry,
} from "./index";

const STALL = "https://stall.test";
const ROUTE = "https://route.test";
const PAY_TO = "0x097f9685D1e0752bF8B02d61E5Ce9be7eA0FBA7F";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const signer = privateKeyToAccount(generatePrivateKey());

const FRAMEWORK_LOG: FrameworkLogEntry[] = [
    {
        tool: "fleet_check_route_probe",
        action: "fleet_check_route_probe",
        resource: "https://service.example.com/v1/endpoint",
        verdict: "OK",
        defect: null,
        defects: [],
        http_status: 402,
        message:
            "fleet_check_route_probe https://service.example.com/v1/endpoint: OK — answers 402 with a parseable challenge, no defect found",
    },
    {
        tool: "fleet_check_route_probe",
        action: "fleet_check_route_probe",
        resource: "https://service.example.com/v1/broken",
        verdict: "DOWN",
        defect: "server_error",
        defects: ["server_error"],
        http_status: 500,
        message:
            "fleet_check_route_probe https://service.example.com/v1/broken: DOWN (server_error: target returned HTTP 500)",
    },
];

function challenge(amount: string, path: string): Record<string, unknown> {
    return {
        x402Version: 2,
        error: "Payment required",
        resource: { url: `${STALL}${path}`, description: "fleet check", mimeType: "application/json", serviceName: "stall-row" },
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
        const isRequest = typeof input === "object" && input !== null && "url" in input;
        let body: unknown;
        if (init?.body) {
            body = JSON.parse(String(init.body));
        } else if (isRequest) {
            const text = await (input as Request).clone().text();
            body = text ? JSON.parse(text) : undefined;
        }
        const req: SeenRequest = {
            url: isRequest ? (input as Request).url : String(input),
            headers: new Headers(
                init?.headers ?? (isRequest ? (input as Request).headers : undefined),
            ),
            body,
        };
        seen.push(req);
        return handler(req);
    }) as unknown as typeof fetch;
    return { fetchImpl, seen };
}

function paidHandler(result: Record<string, unknown>, amountFor?: (path: string) => string) {
    return (req: SeenRequest) => {
        const u = new URL(req.url);
        // Pack-funded / free calls answer directly — no challenge.
        if (u.pathname === "/v1/fleet-check/run" || u.pathname === "/v1/fleet-check/status") {
            return new Response(JSON.stringify(result), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        }
        if (!req.headers.get("payment-signature")) {
            const amount = amountFor
                ? amountFor(u.pathname)
                : String(ROUTE_PRICES[u.pathname] ?? 50_000);
            return challengeResponse(challenge(amount, u.pathname));
        }
        return new Response(JSON.stringify(result), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    };
}

function makeClient(fetchImpl: typeof fetch) {
    return new InspectorClient({
        signer,
        stallRowUrl: STALL,
        routeVerdictUrl: ROUTE,
        fetchImpl,
    });
}

describe("fleet check prices", () => {
    it("pins the pack at $5.00 and the single sweep at $0.10", () => {
        expect(ROUTE_PRICES["/v1/fleet-check/pack"]).toBe(5_000_000);
        expect(ROUTE_PRICES["/v1/fleet-check"]).toBe(100_000);
    });
});

describe("fleet check helper — mocked calls", () => {
    it("buyFleetCheckPack pays exactly 5000000 units and returns renewal terms", async () => {
        const delivery = {
            pack_id: "fcpack_test",
            credits_total: 100,
            credits_remaining: 100,
            renewal: { renewal_cycle_days: 90, renewal_price_units: 5_000_000, days_remaining: 90 },
        };
        const { fetchImpl, seen } = mockFetch(paidHandler(delivery));
        const client = makeClient(fetchImpl);
        const result = await client.buyFleetCheckPack({
            origins: ["https://service.example.com"],
            intervalS: 3600,
        });
        expect(result.pack_id).toBe("fcpack_test");
        expect(result.renewal?.renewal_cycle_days).toBe(90);
        expect(seen).toHaveLength(2);
        expect(new URL(seen[0].url).pathname).toBe("/v1/fleet-check/pack");
        expect(seen[0].body).toEqual({
            origins: ["https://service.example.com"],
            interval_s: 3600,
        });
        const payload = JSON.parse(
            Buffer.from(seen[1].headers.get("payment-signature")!, "base64").toString("utf-8"),
        );
        expect(payload.payload.authorization.value).toBe("5000000");
        expect(payload.payload.authorization.to).toBe(PAY_TO);
    });

    it("fleetCheckSweep pays exactly 100000 units and exposes framework_log lines", async () => {
        const delivery = { summary: { resources: 2, ok: 1, down: 1 }, framework_log: FRAMEWORK_LOG };
        const { fetchImpl, seen } = mockFetch(paidHandler(delivery));
        const client = makeClient(fetchImpl);
        const result = await client.fleetCheckSweep({
            resources: ["https://service.example.com/v1/endpoint"],
        });
        expect(frameworkLogEntries(result)).toEqual(FRAMEWORK_LOG);
        expect(frameworkLogLines(result)).toEqual(FRAMEWORK_LOG.map((e) => e.message));
        const payload = JSON.parse(
            Buffer.from(seen[1].headers.get("payment-signature")!, "base64").toString("utf-8"),
        );
        expect(payload.payload.authorization.value).toBe("100000");
    });

    it("runFleetCheckSweep spends a pack credit — a single plain call", async () => {
        const delivery = {
            pack_id: "fcpack_test",
            status: "swept",
            credits_remaining: 99,
            framework_log: FRAMEWORK_LOG,
        };
        const { fetchImpl, seen } = mockFetch(paidHandler(delivery));
        const client = makeClient(fetchImpl);
        const result = await client.runFleetCheckSweep("fcpack_test");
        expect(result.credits_remaining).toBe(99);
        expect(frameworkLogLines(result)).toHaveLength(2);
        expect(seen).toHaveLength(1);
        expect(seen[0].headers.get("payment-signature")).toBeNull();
        expect(seen[0].body).toEqual({ pack_id: "fcpack_test" });
    });

    it("fleetCheckStatus is a free read carrying framework_log + renewal", async () => {
        const delivery = {
            pack_id: "fcpack_test",
            credits_remaining: 99,
            framework_log: FRAMEWORK_LOG,
            renewal: { renewal_cycle_days: 90, days_remaining: 89 },
            latest_run: { summary: { ok: 1 } },
        };
        const { fetchImpl, seen } = mockFetch(paidHandler(delivery));
        const client = makeClient(fetchImpl);
        const result = await client.fleetCheckStatus("fcpack_test");
        expect(result.renewal?.days_remaining).toBe(89);
        expect(frameworkLogEntries(result)[1].defect).toBe("server_error");
        expect(seen).toHaveLength(1);
        expect(seen[0].headers.get("payment-signature")).toBeNull();
    });

    it("refuses an over-price pack challenge under the $5.00 spend guard", async () => {
        const { fetchImpl, seen } = mockFetch(
            paidHandler({ should: "never arrive" }, () => "6000000"),
        );
        const client = makeClient(fetchImpl);
        await expect(
            client.buyFleetCheckPack({ origins: ["https://service.example.com"] }),
        ).rejects.toBeInstanceOf(SpendGuardError);
        expect(seen.every((r) => !r.headers.get("payment-signature"))).toBe(true);
    });

    it("frameworkLog helpers tolerate deliveries without a log", () => {
        expect(frameworkLogEntries({})).toEqual([]);
        expect(frameworkLogLines(undefined)).toEqual([]);
        expect(frameworkLogLines(null)).toEqual([]);
    });
});
