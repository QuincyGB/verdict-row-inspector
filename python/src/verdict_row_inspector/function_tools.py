"""Function-calling schema pack for the Verdict Row x402 fleet.

Drop-in LLM tool definitions for every fleet route priced
<= $0.05, in OpenAI and Anthropic formats. The data
(function_tools.json, packaged beside this module) is GENERATED
from the fleet's canonical route registry by the fleet-checker's
function_tools.py — prices, descriptions and request schemas are
copied programmatically from the routes' live discovery terms,
never hand-typed. The same pack is served at
https://verdictrow.com/function-tools.json

Each tool is a paid POST endpoint on the x402 exact scheme
(USDC on Base): an unpaid call returns HTTP 402 with the payment
challenge. These definitions describe the tools for an LLM tool
list; handling the payment leg is the caller's x402 client.
"""

from __future__ import annotations

import json
from importlib.resources import files


def _load_pack() -> dict:
    resource = files(__package__).joinpath("function_tools.json")
    return json.loads(resource.read_text(encoding="utf-8"))


#: The full pack: both formats, the route index and payment terms.
FUNCTION_TOOLS_PACK: dict = _load_pack()

#: OpenAI-format tool definitions (``tools`` argument shape).
OPENAI_TOOLS: list = FUNCTION_TOOLS_PACK["openai"]

#: Anthropic-format tool definitions (``tools`` argument shape).
ANTHROPIC_TOOLS: list = FUNCTION_TOOLS_PACK["anthropic"]

#: The route index embedded in the pack (the registry snapshot:
#: one entry per tool, with its stall, path and exact price).
FUNCTION_TOOL_ROUTES: list = FUNCTION_TOOLS_PACK["routes"]


def get_function_tool(name: str, format: str = "openai") -> dict | None:
    """Look up one tool by its stable snake_case name, in either
    format ("openai" or "anthropic"). None when not in the pack."""
    if format == "anthropic":
        return next((t for t in ANTHROPIC_TOOLS if t["name"] == name), None)
    if format == "openai":
        return next(
            (t for t in OPENAI_TOOLS if t["function"]["name"] == name), None
        )
    raise ValueError(f"unknown format {format!r}: expected 'openai' or 'anthropic'")


__all__ = [
    "ANTHROPIC_TOOLS",
    "FUNCTION_TOOLS_PACK",
    "FUNCTION_TOOL_ROUTES",
    "OPENAI_TOOLS",
    "get_function_tool",
]
