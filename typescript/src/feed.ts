/**
 * Recheck feed v2: hash-chained envelopes + chain verification.
 *
 * The chain rule is the service's own (stall-row
 * app/services/recheck.py, WatchStore.verify_chain):
 *
 *   record_hash = sha256(`${prev_hash}\n${canonical_json(record)}`)
 *   canonical_json = JSON with keys sorted at every level and
 *                    (",", ":") separators — Python's
 *                    json.dumps(record, sort_keys=True,
 *                    separators=(",", ":")), including its
 *                    \uXXXX escaping of non-ASCII characters
 *   record_id   = "rec_" + record_hash.slice(0, 24)
 *   genesis prev_hash = "genesis"
 *
 * Filters (origin / pay_to / route / url / watch_id) select a SUBSET
 * of the same chain — envelopes are served exactly as recorded, so
 * seq gaps under a filter are expected and are NOT a chain failure;
 * the per-envelope hash recomputation still applies to every one.
 */

import { createHash } from "node:crypto";

import { FeedChainError } from "./errors";

export const FEED_GENESIS = "genesis";

export interface FeedEnvelope {
    seq: number;
    recordId: string;
    schemaVersion: number;
    prevHash: string;
    recordHash: string;
    record: Record<string, unknown>;
}

export interface FeedPage {
    envelopes: FeedEnvelope[];
    latestSeq: number | null;
    earliestSeq: number | null;
    feedCount: number | null;
    /** The since_seq to resume from: the last envelope's seq. */
    cursor: number | null;
}

/** A resumable feed position: last seq seen + its record_hash.
 * Persist it (two scalars) and hand it back to feed() to resume
 * exactly where you stopped, with the chain link still checkable. */
export interface FeedCursor {
    seq: number;
    lastHash: string | null;
}

export function parseEnvelope(line: string): FeedEnvelope {
    const data = JSON.parse(line) as Record<string, unknown>;
    return {
        seq: Number(data.seq),
        recordId: String(data.record_id),
        schemaVersion: Number(data.schema_version),
        prevHash: String(data.prev_hash),
        recordHash: String(data.record_hash),
        record: data.record as Record<string, unknown>,
    };
}

/** Python json.dumps(..., sort_keys=True, separators=(",", ":"),
 * ensure_ascii=True) equivalent for JSON values. */
export function canonicalRecordJson(value: unknown): string {
    const raw = canonical(value);
    // Python escapes every non-ASCII char as \uXXXX (lowercase hex).
    return raw.replace(/[^\x00-\x7F]/g, (ch) => {
        const code = ch.charCodeAt(0);
        return "\\u" + code.toString(16).padStart(4, "0");
    });
}

function canonical(value: unknown): string {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value) ?? "null";
    }
    if (Array.isArray(value)) {
        return "[" + value.map(canonical).join(",") + "]";
    }
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return (
        "{" +
        entries.map(([k, v]) => JSON.stringify(k) + ":" + canonical(v)).join(",") +
        "}"
    );
}

export function chainHash(prevHash: string, record: Record<string, unknown>): string {
    return createHash("sha256")
        .update(`${prevHash}\n${canonicalRecordJson(record)}`, "utf-8")
        .digest("hex");
}

/** Per-envelope checks that hold even in a filtered view. */
export function verifyEnvelope(env: FeedEnvelope): void {
    const expected = chainHash(env.prevHash, env.record);
    if (env.recordHash !== expected) {
        throw new FeedChainError(
            `seq ${env.seq}: record_hash ${env.recordHash} does not recompute ` +
                `from (prev_hash, record) — expected ${expected}`,
        );
    }
    if (env.recordId !== `rec_${env.recordHash.slice(0, 24)}`) {
        throw new FeedChainError(
            `seq ${env.seq}: record_id ${env.recordId} does not derive from ` +
                `record_hash ${env.recordHash}`,
        );
    }
}

export interface VerifyPageOptions {
    /** True for an unfiltered cursor walk: seqs must step by exactly
     * 1 and prev_hashes must link. False under a filter. */
    contiguous: boolean;
    afterSeq?: number | null;
    prevHash?: string | null;
}

export function verifyPage(envelopes: FeedEnvelope[], options: VerifyPageOptions): void {
    let expectedSeq =
        options.contiguous && options.afterSeq ? options.afterSeq + 1 : null;
    let link = options.prevHash ?? null;
    for (const env of envelopes) {
        verifyEnvelope(env);
        if (options.contiguous) {
            if (expectedSeq !== null && env.seq !== expectedSeq) {
                throw new FeedChainError(
                    `gap in the feed chain: expected seq ${expectedSeq}, got seq ${env.seq}`,
                );
            }
            if (link !== null && env.prevHash !== link) {
                throw new FeedChainError(
                    `seq ${env.seq}: prev_hash ${env.prevHash} does not link to ` +
                        `the previous record_hash ${link}`,
                );
            }
            expectedSeq = env.seq + 1;
            link = env.recordHash;
        }
    }
}
