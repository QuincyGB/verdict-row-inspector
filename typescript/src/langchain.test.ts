/**
 * LangChain tools tests. Fully offline: the InspectorClient is
 * built with an injected mock fetch (no signer — the mock answers
 * 200 directly, the same free-200 shape the Python suites use), and
 * feed fixtures are generated with the SDK's own chain rule.
 */

import { describe, expect, it } from "vitest";

import { InspectorClient } from "./client";
import { FEED_GENESIS, chainHash, type FeedEnvelope } from "./feed";
import { FUNCTION_TOOL_ROUTES, getFunctionTool } from "./function-tools";
import { FEED_TOOL_NAME, getLangChainTools } from "./langchain";

const STALL = "https://stall.test";
const TOKEN = "https://token.test";

interface SeenRequest {
    url: string;
    body: unknown;
}

function mockFetch(handler: (req: SeenRequest) => Response) {
    const seen: SeenRequest[] = [];
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        const rawBody = init?.body ?? (typeof input === "object" ? await (input as Request).clone().text() : undefined);
        seen.push({ url: String(url), body: rawBody ? JSON.parse(String(rawBody)) : undefined });
        return handler(seen[seen.length - 1]);
    }) as typeof fetch;
    return { seen, fetchImpl };
}

function clientWith(handler: (req: SeenRequest) => Response) {
    const { seen, fetchImpl } = mockFetch(handler);
    const client = new InspectorClient({
        stallRowUrl: STALL,
        tokenVerdictUrl: TOKEN,
        fetchImpl,
    });
    return { client, seen };
}

function json200(payload: Record<string, unknown>): Response {
    return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
}

function makeEnvelope(seq: number, prevHash: string, record: Record<string, unknown>): FeedEnvelope {
    const recordHash = chainHash(prevHash, record);
    return {
        seq,
        recordId: `rec_${recordHash.slice(0, 24)}`,
        schemaVersion: 2,
        prevHash,
        recordHash,
        record,
    };
}

function feedResponse(envelopes: FeedEnvelope[]): Response {
    const text = envelopes
        .map((env) =>
            JSON.stringify({
                seq: env.seq,
                record_id: env.recordId,
                schema_version: env.schemaVersion,
                prev_hash: env.prevHash,
                record_hash: env.recordHash,
                record: env.record,
            }),
        )
        .join("\n");
    return new Response(text, {
        status: 200,
        headers: {
            "X-Recheck-Feed-Latest-Seq": String(envelopes[envelopes.length - 1].seq),
            "X-Recheck-Feed-Count": String(envelopes.length),
        },
    });
}

describe("langchain tools — inventory pinned to the pack", () => {
    it("exposes exactly the 24 pack tools + the free feed tool", () => {
        const { client } = clientWith(() => json200({}));
        const tools = getLangChainTools(client);
        expect(tools.map((t) => t.name)).toEqual([
            ...FUNCTION_TOOL_ROUTES.map((r) => r.name),
            FEED_TOOL_NAME,
        ]);
        expect(tools).toHaveLength(25);
        for (const route of FUNCTION_TOOL_ROUTES) {
            const tool = tools.find((t) => t.name === route.name)!;
            expect(tool.description).toContain(route.price_display);
            expect(tool.description).toContain(route.amount_units_base);
            expect(Number(route.amount_units_base)).toBeLessThanOrEqual(50000);
        }
        const feed = tools.find((t) => t.name === FEED_TOOL_NAME)!;
        expect(feed.description).toContain("FREE");
    });

    it("carries zod schemas faithful to the pack schemas", () => {
        const { client } = clientWith(() => json200({}));
        const tools = getLangChainTools(client);
        const byName = new Map(tools.map((t) => [t.name, t]));
        for (const route of FUNCTION_TOOL_ROUTES) {
            const anthropic = getFunctionTool(route.name, "anthropic")!;
            const schema = byName.get(route.name)!.schema as unknown as {
                shape: Record<string, unknown>;
            };
            expect(Object.keys(schema.shape).sort()).toEqual(
                Object.keys(
                    (anthropic.input_schema as { properties: object }).properties,
                ).sort(),
            );
        }
        const recheck = byName.get("stall_row_recheck")!.schema as unknown as {
            safeParse: (v: unknown) => { success: boolean };
        };
        expect(recheck.safeParse({ url: "https://example.com/v1/x" }).success).toBe(true);
        expect(recheck.safeParse({}).success).toBe(false);
    });
});

describe("langchain tools — mocked invokes", () => {
    it("paid invoke performs the call through the SDK client (stall-row)", async () => {
        const { client, seen } = clientWith(() => json200({ gas_price_gwei: "0.05" }));
        const tools = getLangChainTools(client);
        const gas = tools.find((t) => t.name === "stall_row_gas_oracle")!;
        const out = JSON.parse(await gas.invoke({}));
        expect(out).toEqual({ gas_price_gwei: "0.05" });
        expect(seen).toHaveLength(1);
        expect(seen[0].url).toBe(`${STALL}/v1/gas-oracle`);
    });

    it("paid invoke routes cross-stall tools to their own origin", async () => {
        const { client, seen } = clientWith(() => json200({ verdict: "SOLID", score: 91 }));
        const tools = getLangChainTools(client);
        const tv = tools.find((t) => t.name === "token_verdict_verdict")!;
        const out = JSON.parse(await tv.invoke({ address: "0xabc", chain: "base" }));
        expect(out.verdict).toBe("SOLID");
        expect(seen[0].url).toBe(`${TOKEN}/v1/verdict`);
        expect(seen[0].body).toEqual({ address: "0xabc", chain: "base" });
    });

    it("feed tool walks the cursor across invokes", async () => {
        const env1 = makeEnvelope(1, FEED_GENESIS, { url: "https://example.com/1", status: "CHANGED" });
        const env2 = makeEnvelope(2, env1.recordHash, { url: "https://example.com/2", status: "CHANGED" });
        let call = 0;
        const { client, seen } = clientWith(() => {
            call += 1;
            return feedResponse(call === 1 ? [env1] : [env2]);
        });
        const tools = getLangChainTools(client);
        const feed = tools.find((t) => t.name === FEED_TOOL_NAME)!;
        const first = JSON.parse(await feed.invoke({ limit: 1 }));
        expect(first.format).toBe("recheck-feed-v2");
        expect(first.count).toBe(1);
        expect(first.cursor).toBe(1);
        expect(first.records[0].record_id).toBe(env1.recordId);
        const second = JSON.parse(await feed.invoke({}));
        expect(second.count).toBe(1);
        expect(second.cursor).toBe(2);
        expect(seen[1].url).toContain("since_seq=1");
    });

    it("feed tool rejects a tampered chain", async () => {
        const env1 = makeEnvelope(1, FEED_GENESIS, { url: "https://example.com/1", status: "CHANGED" });
        env1.record = { url: "https://evil.example.com", status: "CHANGED" };
        const { client } = clientWith(() => feedResponse([env1]));
        const tools = getLangChainTools(client);
        const feed = tools.find((t) => t.name === FEED_TOOL_NAME)!;
        await expect(feed.invoke({})).rejects.toThrow(/does not recompute/);
    });
});
