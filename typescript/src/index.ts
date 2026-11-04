/**
 * @quincygb/verdict-row-inspector — the Inspector SDK for the
 * Verdict Row x402 fleet (TypeScript).
 *
 * One async client for StallRow's inspector surface and
 * RouteVerdict: Recheck, Sign Reader, Score Book, Guard, Inspector
 * Physical, packs, Fleet Passes, Fleet-Pass-funded batch rechecks,
 * the hash-chained Recheck feed v2, watches and signed webhooks.
 * Payment runs through @x402/fetch + @x402/evm (ExactEvmScheme,
 * EIP-3009 exact scheme on Base) behind a per-route spend guard.
 *
 * This is the full inspector client — a different package from
 * @quincygb/x402-guard, the single-purpose pre-pay wrapper.
 *
 * Contact: Ren, Verdict Row Patrol — patrol@verdictrow.com
 */

export {
    BASE_NETWORK,
    DEFAULT_ROUTE_VERDICT_URL,
    DEFAULT_STALL_ROW_URL,
    DEFAULT_TOKEN_VERDICT_URL,
    FLEET_PAY_TO,
    InspectorClient,
    ROUTE_PRICES,
    ROUTE_VERDICT_PRICES,
    USDC_ASSET,
    parsePaymentRequired,
    type BatchRecheckResponse,
    type PackRouteRef,
    type FleetPassResponse,
    type GuardResponse,
    type InspectorClientOptions,
    type PackResponse,
    type PassBalanceResponse,
    type PhysicalResponse,
    type RecheckResponse,
    type RouteVerdictResponse,
    type ScoreBookResponse,
    type SignReadResponse,
    type VerdictReadResponse,
    type WatchRegisterResponse,
    type WebhookRegisterResponse,
} from "./client";
export {
    FeedChainError,
    InspectorError,
    PaymentRequiredError,
    SpendGuardError,
} from "./errors";
export {
    FEED_GENESIS,
    canonicalRecordJson,
    chainHash,
    parseEnvelope,
    verifyEnvelope,
    verifyPage,
    type FeedCursor,
    type FeedEnvelope,
    type FeedPage,
} from "./feed";
export {
    EVENT_ID_HEADER,
    SIGNATURE_HEADER,
    computeWebhookSignature,
    verifyWebhookSignature,
} from "./webhooks";
export {
    ANTHROPIC_TOOLS,
    FUNCTION_TOOLS_PACK,
    FUNCTION_TOOL_ROUTES,
    OPENAI_TOOLS,
    getFunctionTool,
    type AnthropicTool,
    type FunctionToolRoute,
    type FunctionToolsPack,
    type OpenAIFunctionTool,
} from "./function-tools";
