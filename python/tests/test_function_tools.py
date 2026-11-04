"""Function-calling schema pack tests. Fully offline: the pack is
validated against the route index embedded in it — that index is
the registry snapshot the pack was generated from (the fleet's
canonical route registry, via the fleet-checker's
function_tools.py), so a price, name or schema drift inside the
shipped pack fails here.
"""

from __future__ import annotations

import re

import pytest

from verdict_row_inspector import (
    ANTHROPIC_TOOLS,
    FUNCTION_TOOLS_PACK,
    FUNCTION_TOOL_ROUTES,
    OPENAI_TOOLS,
    get_function_tool,
)


def test_pack_covers_exactly_the_embedded_registry_snapshot():
    assert FUNCTION_TOOLS_PACK["kind"] == "verdict-row-function-tools/v1"
    assert FUNCTION_TOOLS_PACK["tool_count"] == len(FUNCTION_TOOL_ROUTES)
    assert len(OPENAI_TOOLS) == len(FUNCTION_TOOL_ROUTES)
    assert len(ANTHROPIC_TOOLS) == len(FUNCTION_TOOL_ROUTES)
    assert FUNCTION_TOOL_ROUTES


def test_names_unique_snake_case_and_match_snapshot():
    openai_names = [t["function"]["name"] for t in OPENAI_TOOLS]
    anthropic_names = [t["name"] for t in ANTHROPIC_TOOLS]
    assert len(set(openai_names)) == len(openai_names)
    assert len(set(anthropic_names)) == len(anthropic_names)
    assert sorted(anthropic_names) == sorted(openai_names)
    for name in openai_names:
        assert re.fullmatch(r"[a-z][a-z0-9_]*", name)
    assert sorted(r["name"] for r in FUNCTION_TOOL_ROUTES) == sorted(openai_names)


def test_prices_in_descriptions_match_registry_snapshot():
    for route in FUNCTION_TOOL_ROUTES:
        # The pack only carries routes priced <= $0.05.
        assert int(route["amount_units_base"]) <= 50000
        openai = get_function_tool(route["name"], "openai")
        anthropic = get_function_tool(route["name"], "anthropic")
        assert openai is not None and anthropic is not None
        for desc in (openai["function"]["description"], anthropic["description"]):
            assert route["price_display"] in desc
            assert route["amount_units_base"] in desc
        # Both formats carry the identical schema for the route.
        assert anthropic["input_schema"] == openai["function"]["parameters"]
        assert openai["type"] == "function"
        assert openai["function"]["parameters"]["type"] == "object"


def test_get_function_tool_unknown_and_bad_format():
    assert get_function_tool("no_such_tool") is None
    assert get_function_tool("no_such_tool", "anthropic") is None
    with pytest.raises(ValueError):
        get_function_tool("no_such_tool", "bogus")
