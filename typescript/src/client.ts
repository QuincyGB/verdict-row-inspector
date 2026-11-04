/**
 * InspectorClient — the Verdict Row inspector surface, paid via x402.
 *
 * The full client the fleet's Inspector Quickstart
 * (https://stall-row-production.up.railway.app/quickstart/typescript)
 * walks by hand, packaged: the cheap paid routes on StallRow
 * (Recheck, Sign Reader, Score Book, Guard, Inspector Physical),
 * RouteVerdict checks, the $1 packs and $5/$20 Fleet Passes,
 * Fleet-Pass-funded batch rechecks, the hash-chained Recheck feed v2
 * with cursor management, watch registration, and self-serve
 * change-webhook registration.
 *
 * Payment is NOT hand-rolled here. Paid calls go through the
 * ecosystem's standard x402 client packages — the same stack the
 * quickstart uses: `x402Client` (@x402/core, re-exported by
 * @x402/fetch) with `ExactEvmScheme` (@x402/evm) behind
 * `wrapFetchWithPayment` (@x402/fetch). The scheme builds and signs
 * the EIP-3009 TransferWithAuthorization (exact scheme, Base
 * eip155:8453, USDC).
 *
 * Spend guard: the x402 client's payment-requirements selector is
 * ours. Before a paid method runs, the client records that route's
 * cap — the route's known price from ROUTE_PRICES, lowered by the
 * caller's maxAmountUnits ceiling when one is set. The selector
 * refuses (SpendGuardError) any live 402 accept whose amount exceeds
 * the cap, BEFORE the scheme creates or signs a payment payload. The
 * SDK's own default $1 spend control is disabled because this
 * per-route guard is strictly tighter and knows the $5/$20 prices.
 *
 * Free reads (feed, verdict-read, pack/pass balances, watch and
 * webhook registration) never need a signer and never pay.
 *
 * One client serves one caller's calls sequentially; the pending-cap
 * selector makes concurrent paid calls on a single client unsafe —
 * use one client per task (the quickstart's own shape).
 */

import { ExactEvmScheme, type ClientEvmSigner } from "@x402/evm";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";

import {
    InspectorError,
    PaymentRequiredError,
    SpendGuardError,
} from "./errors";
import {
    parseEnvelope,
    verifyPage,
    type FeedCursor,
    type FeedEnvelope,
    type FeedPage,
} from "./feed";

export const DEFAULT_STALL_ROW_URL = "https://stall-row-production.up.railway.app";
export const DEFAULT_ROUTE_VERDICT_URL =
    "https://route-verdict-production.up.railway.app";
export const DEFAULT_TOKEN_VERDICT_URL =
    "https://token-verdict-production.up.railway.app";

export const BASE_NETWORK = "eip155:8453";
export const USDC_ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const FLEET_PAY_TO = "0x097f9685D1e0752bF8B02d61E5Ce9be7eA0FBA7F";

/** Known per-route prices in USDC micro-units, verified against the
 * live /.well-known/x402 discovery documents of both stalls on
 * 2026-10-31. The spend guard never signs above a route's entry. */
export const ROUTE_PRICES: Record<string, number> = {
    "/v1/recheck": 5_000,
    "/v1/sign-read": 10_000,
    "/v1/score-book": 10_000,
    "/v1/guard": 10_000,
    "/v1/physical": 50_000,
    "/v1/recheck/pack": 1_000_000,
    "/v1/toolkit/pack": 1_000_000,
    "/v1/fleet-pass": 5_000_000,
    "/v1/fleet-pass-20": 20_000_000,
};

export const ROUTE_VERDICT_PRICES: Record<string, number> = {
    "/v1/check": 50_000,
};

// ---------------------------------------------------------------------------
// Typed responses (the routes' JSON, with the headline fields typed;
// every interface stays open — the services add fields over time).
// ---------------------------------------------------------------------------

export interface RecheckResponse extends Record<string, unknown> {
    url?: string;
    status?: string; // BASELINE | UNCHANGED | CHANGED | ERROR
    current?: Record<string, unknown>;
    field_changes?: unknown[];
}

export interface SignReadResponse extends Record<string, unknown> {
    url?: string;
    challenge_found?: boolean;
    x402_version?: number | null;
    accepts?: unknown[];
    mismatches?: unknown[];
}

export interface ScoreBookResponse extends Record<string, unknown> {
    found?: boolean;
    target?: { type?: string; value?: string };
}

export interface GuardResponse extends Record<string, unknown> {
    url?: string;
    verdict?: string; // PROCEED | CAUTION | ABORT
    reasons?: unknown[];
}

export interface PhysicalResponse extends Record<string, unknown> {
    url?: string;
    verdict?: string;
}

export interface RouteVerdictResponse extends Record<string, unknown> {
    verdict?: string; // TRUSTED | CAUTION | AVOID
    score?: number;
    terms?: Record<string, unknown>;
}

export interface PackResponse extends Record<string, unknown> {
    pack_id?: string;
    credits_total?: number;
    credits_remaining?: number;
}

export interface FleetPassResponse extends Record<string, unknown> {
    pass_id?: string;
    balance_units?: number;
    total_units?: number;
}

export interface PassBalanceResponse extends Record<string, unknown> {
    pass_id?: string;
    balance_units?: number;
    tier?: string;
    expired?: boolean;
}

export interface BatchRecheckResponse extends Record<string, unknown> {
    count?: number;
    results?: RecheckResponse[];
}

export interface VerdictReadResponse extends Record<string, unknown> {
    found?: boolean;
    url?: string;
}

export interface WatchRegisterResponse extends Record<string, unknown> {
    watch_reg_id?: string;
}

export interface WebhookRegisterResponse extends Record<string, unknown> {
    subscription?: { sub_id?: string; [key: string]: unknown };
}

export interface InspectorClientOptions {
    /** The buyer's x402 signer (@x402/evm ClientEvmSigner — a viem
     * LocalAccount satisfies it). Omit for read-only mode: free reads
     * work, paid calls throw PaymentRequiredError with the challenge. */
    signer?: ClientEvmSigner;
    stallRowUrl?: string;
    routeVerdictUrl?: string;
    tokenVerdictUrl?: string;
    /** Caller ceiling in micro-USDC; can only lower a route's cap. */
    maxAmountUnits?: number;
    /** fetch implementation used for EVERY request (inject a fake in
     * tests). Defaults to the global fetch. */
    fetchImpl?: typeof fetch;
}

interface PaymentRequirementShape {
    scheme: string;
    network: string;
    amount: string;
    [key: string]: unknown;
}

/** The route reference a pack dispatch needs — structurally the
 * pack's FunctionToolRoute (function-tools.ts); declared here so the
 * client does not import the pack module. */
export interface PackRouteRef {
    name: string;
    stall: string;
    path: string;
    amount_units_base: string;
}

export class InspectorClient {
    readonly stallRowUrl: string;
    readonly routeVerdictUrl: string;
    readonly tokenVerdictUrl: string;
    readonly maxAmountUnits: number | null;
    feedCursor: FeedCursor = { seq: 0, lastHash: null };
    lastReceipt: Record<string, unknown> | null = null;

    private readonly rawFetch: typeof fetch;
    private readonly payingFetch: typeof fetch | null;
    private pendingCap: number | null = null;
    private pendingPath: string | null = null;

    constructor(options: InspectorClientOptions = {}) {
        this.stallRowUrl = (options.stallRowUrl ?? DEFAULT_STALL_ROW_URL).replace(/\/$/, "");
        this.routeVerdictUrl = (
            options.routeVerdictUrl ?? DEFAULT_ROUTE_VERDICT_URL
        ).replace(/\/$/, "");
        this.tokenVerdictUrl = (
            options.tokenVerdictUrl ?? DEFAULT_TOKEN_VERDICT_URL
        ).replace(/\/$/, "");
        this.maxAmountUnits = options.maxAmountUnits ?? null;
        this.rawFetch = options.fetchImpl ?? globalThis.fetch;

        if (options.signer) {
            const selector = (version: number, requirements: unknown) =>
                this.selectRequirement(
                    version,
                    requirements as PaymentRequirementShape[],
                );
            const client = new x402Client(
                selector as ConstructorParameters<typeof x402Client>[0],
            );
            // Our per-route selector guard replaces the SDK's default
            // $1 cap (which would also refuse the $5/$20 passes).
            client.setSpendControls(false);
            client.register(BASE_NETWORK, new ExactEvmScheme(options.signer));
            this.payingFetch = wrapFetchWithPayment(this.rawFetch, client);
        } else {
            this.payingFetch = null;
        }
    }

    // -- spend guard ------------------------------------------------------

    private capFor(knownPrice: number): number {
        return this.maxAmountUnits !== null
            ? Math.min(knownPrice, this.maxAmountUnits)
            : knownPrice;
    }

    private selectRequirement(
        _version: number,
        requirements: PaymentRequirementShape[],
    ): PaymentRequirementShape {
        for (const req of requirements) {
            if (req.scheme === "exact" && req.network === BASE_NETWORK) {
                const amount = Number(req.amount);
                if (this.pendingCap !== null && amount > this.pendingCap) {
                    throw new SpendGuardError(
                        {},
                        `price ${amount} exceeds spend guard ${this.pendingCap} ` +
                            `for ${this.pendingPath} — refusing to sign`,
                    );
                }
                return req;
            }
        }
        throw new PaymentRequiredError(
            {},
            `challenge offers no exact requirement on ${BASE_NETWORK}: ` +
                JSON.stringify(requirements.map((r) => [r.scheme, r.network])),
        );
    }

    // -- core calls ---------------------------------------------------------

    private async post<T>(
        baseUrl: string,
        path: string,
        body: Record<string, unknown>,
        options: { knownPrice: number | null; headers?: Record<string, string>; funded?: boolean },
    ): Promise<T> {
        const url = baseUrl + path;
        const init: RequestInit = {
            method: "POST",
            headers: { "content-type": "application/json", ...(options.headers ?? {}) },
            body: JSON.stringify(body),
        };
        const paid =
            options.knownPrice !== null && !options.funded && this.payingFetch !== null;
        let response: Response;
        if (paid) {
            this.pendingCap = this.capFor(options.knownPrice as number);
            this.pendingPath = path;
            try {
                response = await (this.payingFetch as typeof fetch)(url, init);
            } catch (exc) {
                const guard = findGuardError(exc);
                if (guard) throw guard;
                throw exc;
            } finally {
                this.pendingCap = null;
                this.pendingPath = null;
            }
        } else {
            response = await this.rawFetch(url, init);
        }
        if (response.status === 402) {
            throw new PaymentRequiredError(
                await parsePaymentRequired(response),
                paid
                    ? "paid retry still returned 402 (payment rejected or expired)"
                    : "endpoint requires x402 payment and no signer is configured " +
                          "(or the presented funding credential did not cover the call)",
            );
        }
        if (response.status !== 200) {
            throw new InspectorError(response.status, await safeJson(response));
        }
        this.lastReceipt = decodeReceipt(response);
        return (await response.json()) as T;
    }

    private async get(path: string, params: Record<string, string>): Promise<Response> {
        const qs = new URLSearchParams(params).toString();
        const response = await this.rawFetch(`${this.stallRowUrl}${path}?${qs}`);
        if (response.status !== 200) {
            throw new InspectorError(response.status, await safeJson(response));
        }
        return response;
    }

    // -- paid inspector routes (StallRow) ------------------------------------

    async recheck(
        url: string,
        options: { watchId?: string; packId?: string; fleetPassId?: string } = {},
    ): Promise<RecheckResponse> {
        const body: Record<string, unknown> = { url };
        if (options.watchId) body.watch_id = options.watchId;
        if (options.packId) body.pack_id = options.packId;
        return this.post(this.stallRowUrl, "/v1/recheck", body, {
            knownPrice: ROUTE_PRICES["/v1/recheck"],
            headers: options.fleetPassId
                ? { "X-Fleet-Pass": options.fleetPassId }
                : undefined,
            funded: Boolean(options.packId || options.fleetPassId),
        });
    }

    async signRead(
        url: string,
        options: {
            declaredMethod?: string;
            declaredAmount?: string;
            declaredPayTo?: string;
            declaredNetwork?: string;
            packId?: string;
        } = {},
    ): Promise<SignReadResponse> {
        const body: Record<string, unknown> = { url };
        if (options.declaredMethod) body.declared_method = options.declaredMethod;
        if (options.declaredAmount) body.declared_amount = options.declaredAmount;
        if (options.declaredPayTo) body.declared_pay_to = options.declaredPayTo;
        if (options.declaredNetwork) body.declared_network = options.declaredNetwork;
        if (options.packId) body.pack_id = options.packId;
        return this.post(this.stallRowUrl, "/v1/sign-read", body, {
            knownPrice: ROUTE_PRICES["/v1/sign-read"],
            funded: Boolean(options.packId),
        });
    }

    async scoreBook(
        target: { url?: string; origin?: string; payTo?: string },
        options: { packId?: string } = {},
    ): Promise<ScoreBookResponse> {
        const body: Record<string, unknown> = {};
        if (target.url) body.url = target.url;
        if (target.origin) body.origin = target.origin;
        if (target.payTo) body.pay_to = target.payTo;
        if (options.packId) body.pack_id = options.packId;
        return this.post(this.stallRowUrl, "/v1/score-book", body, {
            knownPrice: ROUTE_PRICES["/v1/score-book"],
            funded: Boolean(options.packId),
        });
    }

    async guard(
        url: string,
        options: { packId?: string } = {},
    ): Promise<GuardResponse> {
        const body: Record<string, unknown> = { url };
        if (options.packId) body.pack_id = options.packId;
        return this.post(this.stallRowUrl, "/v1/guard", body, {
            knownPrice: ROUTE_PRICES["/v1/guard"],
            funded: Boolean(options.packId),
        });
    }

    async physical(
        url: string,
        options: { watchId?: string } = {},
    ): Promise<PhysicalResponse> {
        const body: Record<string, unknown> = { url };
        if (options.watchId) body.watch_id = options.watchId;
        return this.post(this.stallRowUrl, "/v1/physical", body, {
            knownPrice: ROUTE_PRICES["/v1/physical"],
        });
    }

    // -- RouteVerdict ---------------------------------------------------------

    async routeVerdict(resourceUrl: string): Promise<RouteVerdictResponse> {
        return this.post(this.routeVerdictUrl, "/v1/check", { resource_url: resourceUrl }, {
            knownPrice: ROUTE_VERDICT_PRICES["/v1/check"],
        });
    }

    // -- packs + passes (paid mints) -------------------------------------------

    async buyRecheckPack(url: string): Promise<PackResponse> {
        return this.post(this.stallRowUrl, "/v1/recheck/pack", { url }, {
            knownPrice: ROUTE_PRICES["/v1/recheck/pack"],
        });
    }

    async buyToolkitPack(): Promise<PackResponse> {
        return this.post(this.stallRowUrl, "/v1/toolkit/pack", {}, {
            knownPrice: ROUTE_PRICES["/v1/toolkit/pack"],
        });
    }

    async buyFleetPass(tier: 5 | 20 | "5" | "20" = 5): Promise<FleetPassResponse> {
        const path = String(tier) === "20" ? "/v1/fleet-pass-20" : "/v1/fleet-pass";
        return this.post(this.stallRowUrl, path, {}, {
            knownPrice: ROUTE_PRICES[path],
        });
    }

    // -- Fleet-Pass-funded batch -------------------------------------------------

    async batchRecheck(urls: string[], fleetPassId: string): Promise<BatchRecheckResponse> {
        return this.post(
            this.stallRowUrl,
            "/v1/recheck/batch",
            { urls: [...urls], fleet_pass_id: fleetPassId },
            {
                knownPrice: null,
                funded: true,
                headers: { "X-Fleet-Pass": fleetPassId },
            },
        );
    }

    // -- free reads ----------------------------------------------------------------

    async passBalance(passId: string): Promise<PassBalanceResponse> {
        return this.post(this.stallRowUrl, "/v1/fleet-pass/balance", { pass_id: passId }, {
            knownPrice: null,
        });
    }

    async recheckPackBalance(packId: string): Promise<PackResponse> {
        return this.post(this.stallRowUrl, "/v1/recheck/pack-balance", { pack_id: packId }, {
            knownPrice: null,
        });
    }

    async toolkitPackBalance(packId: string): Promise<PackResponse> {
        return this.post(this.stallRowUrl, "/v1/toolkit/pack-balance", { pack_id: packId }, {
            knownPrice: null,
        });
    }

    async verdictRead(url: string): Promise<VerdictReadResponse> {
        const response = await this.get("/v1/verdict-read", { url });
        return (await response.json()) as VerdictReadResponse;
    }

    // -- feed v2 ----------------------------------------------------------------------

    async feedPage(
        sinceSeq = 0,
        options: {
            limit?: number;
            origin?: string;
            payTo?: string;
            route?: string;
            url?: string;
            watchId?: string;
            verify?: boolean;
        } = {},
    ): Promise<FeedPage> {
        const params: Record<string, string> = { v: "2", since_seq: String(sinceSeq) };
        if (options.limit !== undefined) params.limit = String(options.limit);
        if (options.origin) params.origin = options.origin;
        if (options.payTo) params.pay_to = options.payTo;
        if (options.route) params.route = options.route;
        if (options.url) params.url = options.url;
        if (options.watchId) params.watch_id = options.watchId;
        const response = await this.get("/v1/recheck/feed", params);
        const text = await response.text();
        const envelopes = text
            .split("\n")
            .filter((line) => line.trim())
            .map(parseEnvelope);
        const filtered = Boolean(
            options.origin || options.payTo || options.route || options.url || options.watchId,
        );
        if (options.verify !== false) {
            verifyPage(envelopes, {
                contiguous: !filtered,
                afterSeq: sinceSeq,
                prevHash: null,
            });
        }
        return {
            envelopes,
            latestSeq: intHeader(response, "X-Recheck-Feed-Latest-Seq"),
            earliestSeq: intHeader(response, "X-Recheck-Feed-Earliest-Seq"),
            feedCount: intHeader(response, "X-Recheck-Feed-Count"),
            cursor: envelopes.length ? envelopes[envelopes.length - 1].seq : null,
        };
    }

    /** Cursor-managed feed walk: yields envelopes forward, page by
     * page, verifying the chain as it goes and advancing
     * this.feedCursor after every envelope. */
    async *feed(
        options: {
            sinceSeq?: number;
            pageLimit?: number;
            origin?: string;
            payTo?: string;
            route?: string;
            url?: string;
            watchId?: string;
            maxPages?: number;
            verify?: boolean;
        } = {},
    ): AsyncGenerator<FeedEnvelope> {
        const pageLimit = options.pageLimit ?? 200;
        const filtered = Boolean(
            options.origin || options.payTo || options.route || options.url || options.watchId,
        );
        let cursor = options.sinceSeq ?? this.feedCursor.seq;
        let link = options.sinceSeq === undefined ? this.feedCursor.lastHash : null;
        let pages = 0;
        for (;;) {
            const page = await this.feedPage(cursor, {
                limit: pageLimit,
                origin: options.origin,
                payTo: options.payTo,
                route: options.route,
                url: options.url,
                watchId: options.watchId,
                verify: false,
            });
            if (options.verify !== false) {
                verifyPage(page.envelopes, {
                    contiguous: !filtered,
                    afterSeq: cursor,
                    prevHash: link,
                });
            }
            for (const env of page.envelopes) {
                this.feedCursor = { seq: env.seq, lastHash: env.recordHash };
                cursor = env.seq;
                link = env.recordHash;
                yield env;
            }
            pages += 1;
            if (page.envelopes.length < pageLimit) return;
            if (options.maxPages !== undefined && pages >= options.maxPages) return;
        }
    }

    // -- standing pushes (registration free; runs spend funding) ------------------------

    async watchRegister(
        url: string,
        options: {
            webhookUrl?: string;
            email?: string;
            intervalS?: number;
            packId?: string;
            fleetPassId?: string;
            checkKind?: "recheck" | "route_verdict";
        } = {},
    ): Promise<WatchRegisterResponse> {
        const body: Record<string, unknown> = {
            url,
            check_kind: options.checkKind ?? "recheck",
        };
        if (options.webhookUrl) body.webhook_url = options.webhookUrl;
        if (options.email) body.email = options.email;
        if (options.intervalS !== undefined) body.interval_s = options.intervalS;
        if (options.packId) body.pack_id = options.packId;
        if (options.fleetPassId) body.fleet_pass_id = options.fleetPassId;
        return this.post(this.stallRowUrl, "/v1/watch/register", body, { knownPrice: null });
    }

    async webhookRegister(
        callbackUrl: string,
        secret: string,
        options: {
            url?: string;
            origin?: string;
            packId?: string;
            fleetPassId?: string;
        } = {},
    ): Promise<WebhookRegisterResponse> {
        const body: Record<string, unknown> = { callback_url: callbackUrl, secret };
        if (options.url) body.url = options.url;
        if (options.origin) body.origin = options.origin;
        if (options.packId) body.pack_id = options.packId;
        if (options.fleetPassId) body.fleet_pass_id = options.fleetPassId;
        return this.post(this.stallRowUrl, "/v1/recheck/webhooks", body, { knownPrice: null });
    }

    async webhookList(secret: string): Promise<Record<string, unknown>> {
        return this.post(this.stallRowUrl, "/v1/recheck/webhooks/list", { secret }, {
            knownPrice: null,
        });
    }

    async webhookDelete(secret: string, subId: string): Promise<Record<string, unknown>> {
        return this.post(
            this.stallRowUrl,
            "/v1/recheck/webhooks/delete",
            { secret, sub_id: subId },
            { knownPrice: null },
        );
    }

    // -- generic pack dispatch (the framework wrappers' paid leg) ---------------

    /** Call any Item-4 pack route by its pack route entry, through
     * this client's x402 payment stack and per-route spend guard
     * (the cap is the pack's own price). `undefined` args are dropped
     * from the wire body. This is the single paid leg the LangChain
     * tools (langchain.ts) invoke; the hand-written methods above
     * stay the typed surface for the inspector routes. */
    async callPackRoute(
        route: PackRouteRef,
        args: Record<string, unknown> = {},
    ): Promise<Record<string, unknown>> {
        const baseUrl =
            route.stall === "route-verdict"
                ? this.routeVerdictUrl
                : route.stall === "token-verdict"
                  ? this.tokenVerdictUrl
                  : this.stallRowUrl;
        const body: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(args)) {
            if (value !== undefined) body[key] = value;
        }
        return this.post(baseUrl, route.path, body, {
            knownPrice: Number(route.amount_units_base),
        });
    }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function findGuardError(exc: unknown): SpendGuardError | null {
    let current: unknown = exc;
    const seen = new Set<unknown>();
    while (current && !seen.has(current)) {
        seen.add(current);
        if (current instanceof SpendGuardError) return current;
        // @x402/fetch wraps payload-creation failures in a plain
        // Error and discards the cause; the selector's refusal
        // survives only in the message. Rebuild our typed error
        // from it so callers can catch SpendGuardError reliably.
        const message = (current as { message?: unknown }).message;
        if (typeof message === "string" && message.includes("exceeds spend guard")) {
            const inner = message.replace(/^Failed to create payment payload: /, "");
            return new SpendGuardError({}, inner);
        }
        current = (current as { cause?: unknown }).cause;
    }
    return null;
}

/** Parse the x402 v2 challenge from a 402 Response (base64
 * `payment-required` header first, JSON body second). */
export async function parsePaymentRequired(
    response: Response,
): Promise<Record<string, unknown>> {
    const header = response.headers.get("payment-required");
    if (header) {
        try {
            const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
            if (decoded && Array.isArray(decoded.accepts)) return decoded;
        } catch {
            // fall through to the body
        }
    }
    try {
        const body = (await response.clone().json()) as Record<string, unknown>;
        if (body && Array.isArray(body.accepts)) return body;
    } catch {
        // no usable body either
    }
    throw new Error("402 response carried no parseable x402 payment challenge");
}

function decodeReceipt(response: Response): Record<string, unknown> | null {
    const raw = response.headers.get("payment-response");
    if (!raw) return null;
    try {
        return JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
    } catch {
        return null;
    }
}

function intHeader(response: Response, name: string): number | null {
    const raw = response.headers.get(name);
    return raw === null ? null : Number(raw);
}

async function safeJson(response: Response): Promise<unknown> {
    try {
        return await response.clone().json();
    } catch {
        return (await response.text()).slice(0, 500);
    }
}
