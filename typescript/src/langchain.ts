/**
 * LangChain JS tools for the Verdict Row x402 fleet.
 *
 * One `DynamicStructuredTool` per Item-4 pack tool — the 24 fleet
 * routes priced <= $0.05 — generated from the same embedded pack as
 * function-tools.ts, so names, descriptions (price included) and
 * input schemas cannot drift from the registry. Each tool's invoke
 * performs the paid call through the InspectorClient's existing
 * x402 payment stack (spend guard included) via
 * `client.callPackRoute(...)`; with no signer on the client, a paid
 * invoke throws the client's PaymentRequiredError carrying the
 * parsed challenge.
 *
 * Plus the differentiator: `stall_row_recheck_feed`, a FREE tool
 * that reads StallRow's Recheck feed v2 through the client's
 * cursor-managed, hash-chain-verifying feed walk — verified-
 * continuous reads no other wrapper can offer, because nobody
 * else's data is hash-chained. It is kept clearly separate from
 * the 24 paid tools (no payment, ever).
 *
 * CrewAI has no TypeScript channel — the CrewAI surface for this
 * fleet is the Python `verdict-row-crewai` package.
 *
 * `@langchain/core` and `zod` are peer dependencies: this module is
 * the package's `./langchain` entry point and is never imported by
 * the main entry, so SDK-only users need neither installed.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

import type { InspectorClient } from "./client";
import type { FeedEnvelope } from "./feed";
import { ANTHROPIC_TOOLS, FUNCTION_TOOL_ROUTES } from "./function-tools";

export const FEED_TOOL_NAME = "stall_row_recheck_feed";

export const FEED_TOOL_DESCRIPTION =
    "FREE — read StallRow's Recheck feed v2: the hash-chained, " +
    "cursor-managed stream of recheck records (price / payTo / schema " +
    "changes the fleet's patrol has observed). No payment. Call with " +
    "no cursor to resume where this tool last stopped; every record's " +
    "hash is verified by the client, so a tampered or dropped record " +
    "throws instead of passing silently. Optional since_seq / limit / " +
    "watch_id / url / origin / pay_to / route filters.";

// ---------------------------------------------------------------------------
// JSON Schema -> zod (the pack's schemas are flat objects; the
// converter also handles nested objects/arrays and nullable unions).
// ---------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;

function schemaToZod(schema: JsonSchema): z.ZodType {
    const rawType = schema.type;
    const types = Array.isArray(rawType) ? (rawType as string[]) : [rawType as string];
    const nullable = types.includes("null");
    const base = types.find((t) => t !== "null") ?? "string";

    let out: z.ZodType;
    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
        const values = schema.enum as unknown[];
        out =
            values.length === 1
                ? z.literal(values[0] as string)
                : z.union(
                      values.map((v) => z.literal(v as string)) as unknown as [
                          z.ZodType,
                          z.ZodType,
                          ...z.ZodType[],
                      ],
                  );
    } else if (base === "object") {
        out = objectSchemaToZod(schema);
    } else if (base === "array") {
        const items = schema.items as JsonSchema | undefined;
        out = z.array(items ? schemaToZod(items) : z.unknown());
    } else if (base === "integer") {
        let num = z.number().int();
        if (typeof schema.minimum === "number") num = num.min(schema.minimum);
        if (typeof schema.maximum === "number") num = num.max(schema.maximum);
        out = num;
    } else if (base === "number") {
        out = z.number();
    } else if (base === "boolean") {
        out = z.boolean();
    } else {
        out = z.string();
    }
    if (typeof schema.description === "string") {
        out = out.describe(schema.description);
    }
    return nullable ? out.nullable() : out;
}

function objectSchemaToZod(schema: JsonSchema): z.ZodType {
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    const required = new Set((schema.required ?? []) as string[]);
    const shape: Record<string, z.ZodType> = {};
    for (const [key, prop] of Object.entries(properties)) {
        let field = schemaToZod(prop ?? {});
        if (!required.has(key) && !("default" in (prop ?? {}))) {
            field = field.optional();
        } else if (!required.has(key)) {
            field = field.optional();
        }
        shape[key] = field;
    }
    return z.object(shape);
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

function wireEnvelope(env: FeedEnvelope): Record<string, unknown> {
    return {
        seq: env.seq,
        record_id: env.recordId,
        schema_version: env.schemaVersion,
        prev_hash: env.prevHash,
        record_hash: env.recordHash,
        record: env.record,
    };
}

/** Build the LangChain tool surface bound to one InspectorClient:
 * the 24 paid pack tools (pack order) + the free feed tool (last). */
export function getLangChainTools(
    client: InspectorClient,
): DynamicStructuredTool[] {
    const tools: DynamicStructuredTool[] = FUNCTION_TOOL_ROUTES.map((route) => {
        const def = ANTHROPIC_TOOLS.find((t) => t.name === route.name);
        if (!def) throw new Error(`pack route ${route.name} has no tool definition`);
        return new DynamicStructuredTool({
            name: route.name,
            description: def.description,
            schema: objectSchemaToZod(def.input_schema) as z.ZodObject<
                Record<string, z.ZodType>
            >,
            func: async (args: Record<string, unknown>) =>
                JSON.stringify(await client.callPackRoute(route, args)),
        });
    });

    const feedTool = new DynamicStructuredTool({
        name: FEED_TOOL_NAME,
        description: FEED_TOOL_DESCRIPTION,
        schema: z.object({
            since_seq: z
                .number()
                .int()
                .optional()
                .describe(
                    "Resume cursor: records with seq > since_seq. Omit to resume from the client's stored cursor.",
                ),
            limit: z.number().int().optional().describe("Max records to return."),
            watch_id: z.string().optional().describe("Only records for this watch."),
            url: z.string().optional().describe("Only records for this URL."),
            origin: z.string().optional().describe("Only records for this origin."),
            pay_to: z.string().optional().describe("Only records carrying this payTo."),
            route: z.string().optional().describe("Only records for this route path."),
        }),
        func: async (args: {
            since_seq?: number;
            limit?: number;
            watch_id?: string;
            url?: string;
            origin?: string;
            pay_to?: string;
            route?: string;
        }) => {
            const envelopes: FeedEnvelope[] = [];
            for await (const env of client.feed({
                sinceSeq: args.since_seq,
                pageLimit: args.limit ?? 200,
                maxPages: 1,
                watchId: args.watch_id,
                url: args.url,
                origin: args.origin,
                payTo: args.pay_to,
                route: args.route,
            })) {
                envelopes.push(env);
            }
            return JSON.stringify({
                format: "recheck-feed-v2",
                count: envelopes.length,
                records: envelopes.map(wireEnvelope),
                cursor: client.feedCursor.seq,
                last_hash: client.feedCursor.lastHash,
            });
        },
    });
    tools.push(feedTool);
    return tools;
}

export type { DynamicStructuredTool };
