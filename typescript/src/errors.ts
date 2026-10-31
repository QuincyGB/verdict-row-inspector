/** Errors raised by the Inspector SDK. */

export class InspectorError extends Error {
    readonly status: number;
    readonly detail: unknown;

    constructor(status: number, detail: unknown) {
        super(`inspector request failed: HTTP ${status}: ${JSON.stringify(detail)}`);
        this.name = "InspectorError";
        this.status = status;
        this.detail = detail;
    }
}

export class PaymentRequiredError extends Error {
    readonly challenge: Record<string, unknown>;
    readonly reason: string;

    constructor(challenge: Record<string, unknown>, reason: string) {
        super(reason);
        this.name = "PaymentRequiredError";
        this.challenge = challenge;
        this.reason = reason;
    }

    structuredError(): Record<string, unknown> {
        return {
            error: "payment_required",
            reason: this.reason,
            x402Version: this.challenge.x402Version,
            resource: this.challenge.resource,
            accepts: this.challenge.accepts,
            extensions: this.challenge.extensions,
            hint:
                "Verdict Row inspector routes are priced per call in USDC " +
                "on Base (x402) — see the route's accepts entry for the " +
                "exact price. Configure a signer with an EVM wallet " +
                "holding USDC on Base and the call will be paid " +
                "automatically.",
        };
    }
}

/** The live 402 amount exceeds the route's known price and/or the
 * caller-set ceiling. Raised BEFORE anything is signed. */
export class SpendGuardError extends PaymentRequiredError {
    constructor(challenge: Record<string, unknown>, reason: string) {
        super(challenge, reason);
        this.name = "SpendGuardError";
    }
}

/** The Recheck feed v2 chain does not verify. */
export class FeedChainError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "FeedChainError";
    }
}
