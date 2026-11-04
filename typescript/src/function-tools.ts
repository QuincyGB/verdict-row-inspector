/**
 * Function-calling schema pack for the Verdict Row x402 fleet.
 *
 * Drop-in LLM tool definitions for every fleet route priced
 * <= $0.05, in OpenAI and Anthropic formats. The data
 * (function-tools.json, imported below) is GENERATED from the
 * fleet's canonical route registry by the fleet-checker's
 * function_tools.py — prices, descriptions and request schemas are
 * copied programmatically from the routes' live discovery terms,
 * never hand-typed. The same pack is served at
 * https://verdictrow.com/function-tools.json
 *
 * Each tool is a paid POST endpoint on the x402 exact scheme
 * (USDC on Base): an unpaid call returns HTTP 402 with the payment
 * challenge. These definitions describe the tools for an LLM tool
 * list; handling the payment leg is the caller's x402 client.
 */

import packJson from "./function-tools.json";

export interface OpenAIFunctionTool {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}

export interface AnthropicTool {
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
}

export interface FunctionToolRoute {
    name: string;
    stall: string;
    path: string;
    method: string;
    resource: string;
    price_display: string;
    price_usd: string;
    amount_units_base: string;
}

export interface FunctionToolsPack {
    kind: string;
    version: number;
    registry_generated_at: string;
    tool_count: number;
    routes: FunctionToolRoute[];
    openai: OpenAIFunctionTool[];
    anthropic: AnthropicTool[];
    [key: string]: unknown;
}

/** The full pack: both formats, the route index and payment terms. */
export const FUNCTION_TOOLS_PACK = packJson as unknown as FunctionToolsPack;

/** OpenAI-format tool definitions (`tools` argument shape). */
export const OPENAI_TOOLS: OpenAIFunctionTool[] = FUNCTION_TOOLS_PACK.openai;

/** Anthropic-format tool definitions (`tools` argument shape). */
export const ANTHROPIC_TOOLS: AnthropicTool[] = FUNCTION_TOOLS_PACK.anthropic;

/** The route index embedded in the pack (the registry snapshot:
 * one entry per tool, with its stall, path and exact price). */
export const FUNCTION_TOOL_ROUTES: FunctionToolRoute[] = FUNCTION_TOOLS_PACK.routes;

/** Look up one tool by its stable snake_case name, in either format.
 * Returns undefined when the name is not in the pack. */
export function getFunctionTool(
    name: string,
    format: "openai",
): OpenAIFunctionTool | undefined;
export function getFunctionTool(
    name: string,
    format: "anthropic",
): AnthropicTool | undefined;
export function getFunctionTool(
    name: string,
    format: "openai" | "anthropic" = "openai",
): OpenAIFunctionTool | AnthropicTool | undefined {
    if (format === "anthropic") {
        return ANTHROPIC_TOOLS.find((t) => t.name === name);
    }
    return OPENAI_TOOLS.find((t) => t.function.name === name);
}
