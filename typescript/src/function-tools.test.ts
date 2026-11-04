/**
 * Function-calling schema pack tests. Fully offline: the pack is
 * validated against the route index embedded in it — that index is
 * the registry snapshot the pack was generated from (the fleet's
 * canonical route registry, via the fleet-checker's
 * function_tools.py), so a price, name or schema drift inside the
 * shipped pack fails here.
 */

import { describe, expect, it } from "vitest";

import {
    ANTHROPIC_TOOLS,
    FUNCTION_TOOLS_PACK,
    FUNCTION_TOOL_ROUTES,
    OPENAI_TOOLS,
    getFunctionTool,
} from "./index";

describe("function-calling schema pack", () => {
    it("covers exactly the embedded registry snapshot routes", () => {
        expect(FUNCTION_TOOLS_PACK.kind).toBe("verdict-row-function-tools/v1");
        expect(FUNCTION_TOOLS_PACK.tool_count).toBe(FUNCTION_TOOL_ROUTES.length);
        expect(OPENAI_TOOLS.length).toBe(FUNCTION_TOOL_ROUTES.length);
        expect(ANTHROPIC_TOOLS.length).toBe(FUNCTION_TOOL_ROUTES.length);
        expect(FUNCTION_TOOL_ROUTES.length).toBeGreaterThan(0);
    });

    it("has unique stable snake_case names in both formats", () => {
        const openaiNames = OPENAI_TOOLS.map((t) => t.function.name);
        const anthropicNames = ANTHROPIC_TOOLS.map((t) => t.name);
        expect(new Set(openaiNames).size).toBe(openaiNames.length);
        expect(new Set(anthropicNames).size).toBe(anthropicNames.length);
        expect([...anthropicNames].sort()).toEqual([...openaiNames].sort());
        for (const name of openaiNames) {
            expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
        }
        // Every snapshot route has a tool, and vice versa.
        expect([...FUNCTION_TOOL_ROUTES.map((r) => r.name)].sort()).toEqual(
            [...openaiNames].sort(),
        );
    });

    it("prices in every description match the registry snapshot", () => {
        for (const route of FUNCTION_TOOL_ROUTES) {
            // The pack only carries routes priced <= $0.05.
            expect(Number(route.amount_units_base)).toBeLessThanOrEqual(50000);
            const openai = getFunctionTool(route.name, "openai");
            const anthropic = getFunctionTool(route.name, "anthropic");
            expect(openai).toBeDefined();
            expect(anthropic).toBeDefined();
            for (const desc of [
                openai!.function.description,
                anthropic!.description,
            ]) {
                expect(desc).toContain(route.price_display);
                expect(desc).toContain(route.amount_units_base);
            }
            // Both formats carry the identical schema for the route.
            expect(anthropic!.input_schema).toEqual(openai!.function.parameters);
            expect(openai!.type).toBe("function");
            expect(
                (openai!.function.parameters as { type?: string }).type,
            ).toBe("object");
        }
    });

    it("returns undefined for unknown tools", () => {
        expect(getFunctionTool("no_such_tool", "openai")).toBeUndefined();
        expect(getFunctionTool("no_such_tool", "anthropic")).toBeUndefined();
    });
});
