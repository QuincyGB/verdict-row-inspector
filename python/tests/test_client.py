"""Inspector SDK tests. ALL payments are mocked — the HTTP layer is
an httpx MockTransport and the signer is a throwaway account
generated at test time. No test touches the network or spends
anything.

Fixture provenance:
- tests/fixtures/{sign_read,score_book,guard}_example.json are the
  service's own published output examples, copied verbatim from
  stall-row-mcp/tests/fixtures/ (which took them from production).
- The 402 challenges are built field-for-field from the real
  production challenge captured in
  stall-row-mcp/tests/fixtures/payment_required.json (2026-10-27),
  with resource/amount set to the route under test.
- Feed envelopes are generated with the service's own chain rule
  (stall-row app/services/recheck.py: record_hash =
  sha256(prev_hash + "\\n" + canonical_json(record)), genesis
  prev_hash "genesis", record_id "rec_" + record_hash[:24]).
- The webhook signature expectation is computed exactly as the
  service's delivery code and stall-row/tests/test_hooksubs.py do:
  HMAC-SHA256 over the raw body, header `sha256=<hex>`.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
from pathlib import Path

import httpx
import pytest
from eth_account import Account

from verdict_row_inspector import (
    ROUTE_PRICES,
    ROUTE_VERDICT_PRICES,
    FeedChainError,
    InspectorClient,
    PaymentRequiredError,
    SpendGuardError,
    chain_hash,
    verify_webhook_signature,
)

FIXTURES = Path(__file__).parent / "fixtures"
STALL = "https://stall.test"
ROUTE = "https://route.test"
TARGET = "https://token-verdict-production.up.railway.app/v1/verdict"
PAY_TO = "0x097f9685D1e0752bF8B02d61E5Ce9be7eA0FBA7F"
USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"


def run(coro):
    return asyncio.run(coro)


def challenge(amount: str, path: str, base: str = STALL) -> dict:
    """The production challenge shape (see provenance note above)."""
    return {
        "x402Version": 2,
        "error": "Payment required",
        "resource": {
            "url": f"{base}{path}",
            "description": "inspector route",
            "mimeType": "application/json",
            "serviceName": "stall-row",
        },
        "accepts": [
            {
                "scheme": "exact",
                "network": "eip155:8453",
                "asset": USDC,
                "amount": amount,
                "payTo": PAY_TO,
                "maxTimeoutSeconds": 300,
                "extra": {"name": "USD Coin", "version": "2"},
            }
        ],
    }


def challenge_response(ch: dict) -> httpx.Response:
    header = base64.b64encode(json.dumps(ch).encode()).decode()
    return httpx.Response(402, headers={"payment-required": header}, json={})


def receipt_header(account) -> str:
    return base64.b64encode(
        json.dumps(
            {
                "success": True,
                "transaction": "0x" + "ab" * 32,
                "network": "eip155:8453",
                "payer": account.address,
            }
        ).encode()
    ).decode()


class Recorder:
    """MockTransport handler: replays queued responses (or delegates
    to a function), records every request."""

    def __init__(self, responses):
        self.responses = responses
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if callable(self.responses):
            return self.responses(request)
        return self.responses.pop(0)


def make_client(recorder: Recorder, **kwargs) -> InspectorClient:
    transport = httpx.MockTransport(recorder)
    return InspectorClient(
        stall_row_url=STALL, route_verdict_url=ROUTE,
        transport=transport, **kwargs,
    )


def paid_flow(recorder: Recorder, result: dict, account) -> Recorder:
    def handler(request: httpx.Request) -> httpx.Response:
        if "payment-signature" not in request.headers:
            path = request.url.path
            base = STALL if request.url.host == "stall.test" else ROUTE
            prices = ROUTE_PRICES if base == STALL else ROUTE_VERDICT_PRICES
            return challenge_response(
                challenge(str(prices[path]), path, base)
            )
        return httpx.Response(
            200, headers={"payment-response": receipt_header(account)},
            json=result,
        )

    recorder.responses = handler
    return recorder


# --- prices -------------------------------------------------------------------


def test_route_prices_match_live_discovery():
    # Verified against both stalls' /.well-known/x402 on 2026-10-31.
    assert ROUTE_PRICES["/v1/recheck"] == 5_000
    assert ROUTE_PRICES["/v1/sign-read"] == 10_000
    assert ROUTE_PRICES["/v1/score-book"] == 10_000
    assert ROUTE_PRICES["/v1/guard"] == 10_000
    assert ROUTE_PRICES["/v1/physical"] == 50_000
    assert ROUTE_PRICES["/v1/recheck/pack"] == 1_000_000
    assert ROUTE_PRICES["/v1/toolkit/pack"] == 1_000_000
    assert ROUTE_PRICES["/v1/fleet-pass"] == 5_000_000
    assert ROUTE_PRICES["/v1/fleet-pass-20"] == 20_000_000
    assert ROUTE_VERDICT_PRICES["/v1/check"] == 50_000


# --- payment flow ---------------------------------------------------------------


def test_paid_recheck_signs_eip3009_and_retries():
    account = Account.create()
    recorder = paid_flow(Recorder([]), {"status": "BASELINE", "url": TARGET}, account)
    client = make_client(recorder, signer=account)

    result = run(client.recheck(TARGET))
    assert result["status"] == "BASELINE"
    assert len(recorder.requests) == 2
    assert "payment-signature" not in recorder.requests[0].headers

    payload = json.loads(
        base64.b64decode(recorder.requests[1].headers["payment-signature"])
    )
    assert payload["x402Version"] == 2
    assert payload["accepted"]["amount"] == "5000"
    auth = payload["payload"]["authorization"]
    assert auth["from"] == account.address
    assert auth["to"] == PAY_TO
    assert auth["value"] == "5000"
    assert payload["payload"]["signature"].startswith("0x")
    assert client.last_receipt["success"] is True


def test_route_verdict_paid_flow_hits_route_verdict_host():
    account = Account.create()
    recorder = paid_flow(Recorder([]), {"verdict": "TRUSTED", "score": 97}, account)
    client = make_client(recorder, signer=account)

    result = run(client.route_verdict(TARGET))
    assert result["verdict"] == "TRUSTED"
    assert recorder.requests[0].url.host == "route.test"
    payload = json.loads(
        base64.b64decode(recorder.requests[1].headers["payment-signature"])
    )
    assert payload["accepted"]["amount"] == "50000"


def test_buy_fleet_pass_20_signs_above_the_sdk_default_cap():
    account = Account.create()
    recorder = paid_flow(Recorder([]), {"pass_id": "pass_abc"}, account)
    client = make_client(recorder, signer=account)

    result = run(client.buy_fleet_pass(20))
    assert result["pass_id"] == "pass_abc"
    payload = json.loads(
        base64.b64decode(recorder.requests[1].headers["payment-signature"])
    )
    assert payload["accepted"]["amount"] == "20000000"


def test_sign_read_with_pack_spends_credit_without_paying():
    account = Account.create()
    example = json.loads((FIXTURES / "sign_read_example.json").read_text())
    recorder = Recorder([httpx.Response(200, json=example)])
    client = make_client(recorder, signer=account)

    result = run(client.sign_read(TARGET, pack_id="tpack_1"))
    assert result["challenge_found"] is True
    assert len(recorder.requests) == 1
    assert "payment-signature" not in recorder.requests[0].headers
    assert json.loads(recorder.requests[0].content)["pack_id"] == "tpack_1"


# --- spend guard ------------------------------------------------------------------


def test_spend_guard_refuses_overpriced_challenge_before_signing():
    account = Account.create()
    recorder = Recorder([challenge_response(challenge("6000", "/v1/recheck"))])
    client = make_client(recorder, signer=account)

    with pytest.raises(SpendGuardError):
        run(client.recheck(TARGET))
    # Only the unpaid probe went out; nothing was ever signed.
    assert len(recorder.requests) == 1
    assert "payment-signature" not in recorder.requests[0].headers


def test_spend_guard_honours_caller_ceiling():
    account = Account.create()
    recorder = Recorder([challenge_response(challenge("5000", "/v1/recheck"))])
    client = make_client(recorder, signer=account, max_amount_units=4_000)

    with pytest.raises(SpendGuardError):
        run(client.recheck(TARGET))
    assert len(recorder.requests) == 1


# --- no signer ----------------------------------------------------------------------


def test_no_signer_paid_call_raises_structured_payment_required():
    recorder = Recorder([challenge_response(challenge("5000", "/v1/recheck"))])
    client = make_client(recorder, signer=None)

    with pytest.raises(PaymentRequiredError) as excinfo:
        run(client.recheck(TARGET))
    structured = excinfo.value.structured_error()
    assert structured["error"] == "payment_required"
    assert structured["accepts"][0]["amount"] == "5000"
    assert len(recorder.requests) == 1


def test_free_reads_do_not_require_a_signer():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/verdict-read":
            return httpx.Response(200, json={"found": False, "url": TARGET})
        if request.url.path == "/v1/fleet-pass/balance":
            return httpx.Response(200, json={"pass_id": "pass_1", "balance_units": 5_000_000})
        raise AssertionError(request.url)

    client = make_client(Recorder(handler), signer=None)
    assert run(client.verdict_read(TARGET))["found"] is False
    assert run(client.pass_balance("pass_1"))["balance_units"] == 5_000_000


def test_batch_recheck_is_pass_funded_and_never_pays():
    def handler(request: httpx.Request) -> httpx.Response:
        assert "payment-signature" not in request.headers
        body = json.loads(request.content)
        assert body["fleet_pass_id"] == "pass_1"
        assert body["urls"] == [TARGET]
        return httpx.Response(200, json={"count": 1, "results": [{"url": TARGET, "status": "BASELINE"}]})

    account = Account.create()
    client = make_client(Recorder(handler), signer=account)
    result = run(client.batch_recheck([TARGET], "pass_1"))
    assert result["results"][0]["status"] == "BASELINE"


# --- feed ---------------------------------------------------------------------------


def make_record(seq: int) -> dict:
    return {
        "watch_id": "w",
        "url": TARGET,
        "kind": "x402",
        "status": "BASELINE" if seq == 1 else "UNCHANGED",
        "changes": [],
        "current": {"amount": "5000", "payTo": PAY_TO, "network": "eip155:8453"},
        "checked_at": f"2026-10-31T00:00:0{seq}Z",
    }


def make_envelopes(count: int) -> list[dict]:
    envelopes = []
    prev = "genesis"
    for seq in range(1, count + 1):
        record = make_record(seq)
        record_hash = chain_hash(prev, record)
        envelopes.append(
            {
                "seq": seq,
                "record_id": f"rec_{record_hash[:24]}",
                "schema_version": 1,
                "prev_hash": prev,
                "record_hash": record_hash,
                "record": record,
            }
        )
        prev = record_hash
    return envelopes


def feed_handler(envelopes: list[dict]):
    def handler(request: httpx.Request) -> httpx.Response:
        since = int(request.url.params.get("since_seq", "0"))
        limit = int(request.url.params.get("limit", "200"))
        page = [e for e in envelopes if e["seq"] > since][:limit]
        body = "".join(json.dumps(e) + "\n" for e in page)
        return httpx.Response(
            200, text=body,
            headers={
                "X-Recheck-Feed-Latest-Seq": str(envelopes[-1]["seq"]),
                "X-Recheck-Feed-Earliest-Seq": "1",
                "X-Recheck-Feed-Count": str(len(envelopes)),
            },
        )

    return handler


def test_feed_walk_advances_cursor_across_pages():
    envelopes = make_envelopes(3)
    client = make_client(Recorder(feed_handler(envelopes)), signer=None)

    async def collect():
        return [env async for env in client.feed(page_limit=2)]

    seen = run(collect())
    assert [e.seq for e in seen] == [1, 2, 3]
    assert client.feed_cursor.seq == 3
    assert client.feed_cursor.last_hash == envelopes[-1]["record_hash"]

    # Resuming from the stored cursor yields nothing new.
    assert run(collect()) == []


def test_feed_gap_is_detected():
    envelopes = make_envelopes(3)
    del envelopes[1]  # seqs 1, 3 — a silent drop in an unfiltered walk
    client = make_client(Recorder(feed_handler(envelopes)), signer=None)

    async def collect():
        return [env async for env in client.feed()]

    with pytest.raises(FeedChainError):
        run(collect())


def test_feed_tampered_record_is_detected():
    envelopes = make_envelopes(2)
    envelopes[1]["record"]["current"]["amount"] = "999999"  # hash no longer recomputes
    client = make_client(Recorder(feed_handler(envelopes)), signer=None)

    with pytest.raises(FeedChainError):
        run(client.feed_page(0))


def test_feed_filtered_view_allows_seq_gaps():
    envelopes = [e for e in make_envelopes(3) if e["seq"] != 2]
    client = make_client(Recorder(feed_handler(envelopes)), signer=None)

    page = run(client.feed_page(0, origin="https://token-verdict-production.up.railway.app"))
    assert [e.seq for e in page.envelopes] == [1, 3]
    assert page.latest_seq == 3


# --- webhooks -------------------------------------------------------------------------


def test_webhook_signature_accept_and_reject():
    secret = "test-secret-0123456789"
    body = json.dumps({"event": "recheck.changed", "seq": 7}, sort_keys=True).encode()
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()

    assert verify_webhook_signature(secret, body, f"sha256={expected}") is True
    assert verify_webhook_signature(secret, body, expected) is True
    assert verify_webhook_signature("wrong-secret-0123456", body, f"sha256={expected}") is False
    assert verify_webhook_signature(secret, body + b" ", f"sha256={expected}") is False
    assert verify_webhook_signature(secret, body, None) is False
    assert verify_webhook_signature(secret, body, "sha256=deadbeef") is False


def test_webhook_register_posts_funding_credential():
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body["callback_url"] == "https://hooks.test/cb"
        assert body["pack_id"] == "pack_1"
        assert body["url"] == TARGET
        return httpx.Response(200, json={"subscription": {"sub_id": "sub_1"}})

    client = make_client(Recorder(handler), signer=None)
    result = run(
        client.webhook_register(
            "https://hooks.test/cb", "test-secret-0123456789",
            url=TARGET, pack_id="pack_1",
        )
    )
    assert result["subscription"]["sub_id"] == "sub_1"
