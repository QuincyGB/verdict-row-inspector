"""Verdict Row Inspector SDK (Python).

A client for the Verdict Row x402 fleet's inspector surface:
StallRow's Recheck / Sign Reader / Score Book / Guard / Inspector
Physical, packs and Fleet Passes, the hash-chained Recheck feed v2,
watches and signed change webhooks — plus RouteVerdict checks.
Payment runs through the installed Python x402 SDK (ExactEvmScheme,
EIP-3009 exact scheme on Base) behind a per-route spend guard.

Contact: Ren, Verdict Row Patrol — patrol@verdictrow.com
"""

from .client import (
    BASE_NETWORK,
    DEFAULT_ROUTE_VERDICT_URL,
    DEFAULT_STALL_ROW_URL,
    FLEET_PAY_TO,
    ROUTE_PRICES,
    ROUTE_VERDICT_PRICES,
    USDC_ASSET,
    InspectorClient,
    load_account_from_env,
    parse_payment_required,
)
from .errors import (
    FeedChainError,
    InspectorError,
    PaymentRequiredError,
    SpendGuardError,
)
from .feed import FeedCursor, FeedEnvelope, FeedPage, chain_hash, verify_page
from .function_tools import (
    ANTHROPIC_TOOLS,
    FUNCTION_TOOLS_PACK,
    FUNCTION_TOOL_ROUTES,
    OPENAI_TOOLS,
    get_function_tool,
)
from .webhooks import (
    compute_signature as compute_webhook_signature,
)
from .webhooks import (
    verify_signature as verify_webhook_signature,
)

__version__ = "0.2.0"

__all__ = [
    "ANTHROPIC_TOOLS",
    "FUNCTION_TOOLS_PACK",
    "FUNCTION_TOOL_ROUTES",
    "OPENAI_TOOLS",
    "BASE_NETWORK",
    "DEFAULT_ROUTE_VERDICT_URL",
    "DEFAULT_STALL_ROW_URL",
    "FLEET_PAY_TO",
    "ROUTE_PRICES",
    "ROUTE_VERDICT_PRICES",
    "USDC_ASSET",
    "FeedChainError",
    "FeedCursor",
    "FeedEnvelope",
    "FeedPage",
    "InspectorClient",
    "InspectorError",
    "PaymentRequiredError",
    "SpendGuardError",
    "__version__",
    "chain_hash",
    "compute_webhook_signature",
    "get_function_tool",
    "load_account_from_env",
    "parse_payment_required",
    "verify_page",
    "verify_webhook_signature",
]
