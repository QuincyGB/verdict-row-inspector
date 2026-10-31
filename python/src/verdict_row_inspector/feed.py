"""Recheck feed v2: hash-chained envelopes + chain verification.

Feed v2 (GET /v1/recheck/feed?v=2&since_seq=N) serves one envelope
per line: {seq, record_id, schema_version, prev_hash, record_hash,
record}. The chain rule is the service's own (stall-row
app/services/recheck.py, WatchStore.verify_chain):

    record_hash = sha256(f"{prev_hash}\\n{canonical_json(record)}")
    canonical_json = json.dumps(record, sort_keys=True,
                                separators=(",", ":"))
    record_id   = "rec_" + record_hash[:24]
    genesis prev_hash = "genesis"

since_seq is the gap-proof cursor: records with seq > N, ascending.
Filters (origin / pay_to / route / url / watch_id) select a SUBSET of
the same chain — envelopes are served exactly as recorded, so seq
gaps under a filter are expected and are NOT a chain failure; the
per-envelope hash recomputation still applies to every envelope.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

from .errors import FeedChainError

FEED_GENESIS = "genesis"


def canonical_record_json(record: dict) -> str:
    return json.dumps(record, sort_keys=True, separators=(",", ":"))


def chain_hash(prev_hash: str, record: dict) -> str:
    return hashlib.sha256(
        f"{prev_hash}\n{canonical_record_json(record)}".encode("utf-8")
    ).hexdigest()


@dataclass
class FeedEnvelope:
    seq: int
    record_id: str
    schema_version: int
    prev_hash: str
    record_hash: str
    record: dict[str, Any]

    @classmethod
    def from_json(cls, data: dict) -> "FeedEnvelope":
        return cls(
            seq=int(data["seq"]),
            record_id=str(data["record_id"]),
            schema_version=int(data["schema_version"]),
            prev_hash=str(data["prev_hash"]),
            record_hash=str(data["record_hash"]),
            record=dict(data["record"]),
        )


@dataclass
class FeedPage:
    envelopes: list[FeedEnvelope]
    latest_seq: int | None = None
    earliest_seq: int | None = None
    feed_count: int | None = None

    @property
    def cursor(self) -> int | None:
        """The since_seq to resume from: the last envelope's seq."""
        return self.envelopes[-1].seq if self.envelopes else None


def verify_envelope(env: FeedEnvelope) -> None:
    """Per-envelope checks that hold even in a filtered view."""
    expected = chain_hash(env.prev_hash, env.record)
    if env.record_hash != expected:
        raise FeedChainError(
            f"seq {env.seq}: record_hash {env.record_hash} does not "
            f"recompute from (prev_hash, record) — expected {expected}"
        )
    if env.record_id != f"rec_{env.record_hash[:24]}":
        raise FeedChainError(
            f"seq {env.seq}: record_id {env.record_id} does not derive "
            f"from record_hash {env.record_hash}"
        )


def verify_page(
    envelopes: list[FeedEnvelope],
    *,
    contiguous: bool,
    after_seq: int | None = None,
    prev_hash: str | None = None,
) -> None:
    """Verify a page of envelopes.

    Every envelope's hash must recompute. When `contiguous` is true
    (an unfiltered cursor walk), seqs must also step by exactly 1 —
    starting from `after_seq + 1` when a starting cursor is known —
    and each envelope's prev_hash must equal the previous envelope's
    record_hash (checked against `prev_hash` for the first envelope
    when the walk's predecessor hash is known). Under a filter,
    `contiguous` must be false: seq gaps and unlinked prev_hashes are
    the records the filter excluded, not records dropped.
    """
    expected_seq = (after_seq + 1) if (contiguous and after_seq) else None
    link = prev_hash
    for env in envelopes:
        verify_envelope(env)
        if contiguous:
            if expected_seq is not None and env.seq != expected_seq:
                raise FeedChainError(
                    f"gap in the feed chain: expected seq {expected_seq}, "
                    f"got seq {env.seq}"
                )
            if link is not None and env.prev_hash != link:
                raise FeedChainError(
                    f"seq {env.seq}: prev_hash {env.prev_hash} does not "
                    f"link to the previous record_hash {link}"
                )
            expected_seq = env.seq + 1
            link = env.record_hash


@dataclass
class FeedCursor:
    """A resumable feed position: last seq seen + its record_hash.

    Persist it (it's just two scalars) and hand it back to
    InspectorClient.feed(...) to resume exactly where you stopped,
    with the chain link into the next envelope still checkable.
    """

    seq: int = 0
    last_hash: str | None = None

    def advance(self, env: FeedEnvelope) -> None:
        self.seq = env.seq
        self.last_hash = env.record_hash

    def to_dict(self) -> dict:
        return {"seq": self.seq, "last_hash": self.last_hash}

    @classmethod
    def from_dict(cls, data: dict) -> "FeedCursor":
        return cls(seq=int(data.get("seq", 0)), last_hash=data.get("last_hash"))
