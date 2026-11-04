"""Fleet Check helper tests (Next-20 Item 13: Fleet Check Framework
Packs). ALL payments are mocked — the HTTP layer is an httpx
MockTransport and the signer is a throwaway account generated at
test time. No test touches the network or spends anything.

The 402 challenge shape mirrors tests/test_client.py's provenance
(the real production challenge shape with resource/amount set to
the route under test).
"""

from __future__ import annotations

import asyncio
import base64
import json

import httpx
import pytest
from eth_account import Account

from verdict_row_inspector import (
    ROUTE_PRICES,
    InspectorClient,
    SpendGuardError,
    framework_log_entries,
    framework_log_lines,
)

STALL = "https://stall.test"
ROUTE = "https://route.test"
PAY_TO = "0x097f9685D1e0752bF8B02d61E5Ce9be7eA0FBA7F"
USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"

FRAMEWORK_LOG = [
    {
        "tool": "fleet_check_route_probe",
        "action": "fleet_check_route_probe",
        "resource": "https://service.example.com/v1/endpoint",
        "verdict": "OK",
        "defect": None,
        "defects": [],
        "http_status": 402,
        "message": (
            "fleet_check_route_probe https://service.example.com/v1/endpoint: "
            "OK — answers 402 with a parseable challenge, no defect found"
        ),
    },
    {
        "tool": "fleet_check_route_probe",
        "action": "fleet_check_route_probe",
        "resource": "https://service.example.com/v1/broken",
        "verdict": "DOWN",
        "defect": "server_error",
        "defects": ["server_error"],
        "http_status": 500,
        "message": (
            "fleet_check_route_probe https://service.example.com/v1/broken: "
            "DOWN (server_error: target returned HTTP 500)"
        ),
    },
]


def run(coro):
    return asyncio.run(coro)


def challenge(amount: str, path: str) -> dict:
    return {
        "x402Version": 2,
        "error": "Payment required",
        "resource": {
            "url": f"{STALL}{path}",
            "description": "fleet check",
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


class Recorder:
    def __init__(self, handler):
        self.handler = handler
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.handler(request)


def make_client(recorder: Recorder, account) -> InspectorClient:
    transport = httpx.MockTransport(recorder)
    return InspectorClient(
        account,
        stall_row_url=STALL, route_verdict_url=ROUTE,
        transport=transport,
    )


def paid_handler(result: dict, amount_override: str | None = None):
    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        # Pack-funded / free calls answer directly — no challenge.
        if path in ("/v1/fleet-check/run", "/v1/fleet-check/status"):
            return httpx.Response(200, json=result)
        if "payment-signature" not in request.headers:
            amount = amount_override or str(ROUTE_PRICES[path])
            return challenge_response(challenge(amount, path))
        return httpx.Response(200, json=result)

    return handler


@pytest.fixture()
def account():
    return Account.create()


def test_fleet_check_prices_pinned():
    assert ROUTE_PRICES["/v1/fleet-check/pack"] == 5_000_000
    assert ROUTE_PRICES["/v1/fleet-check"] == 100_000


def test_buy_fleet_check_pack_pays_5_dollars(account):
    delivery = {
        "pack_id": "fcpack_test",
        "credits_total": 100,
        "credits_remaining": 100,
        "renewal": {"renewal_cycle_days": 90, "renewal_price_units": 5_000_000, "days_remaining": 90},
    }
    recorder = Recorder(paid_handler(delivery))
    client = make_client(recorder, account)
    result = run(client.buy_fleet_check_pack(origins=["https://service.example.com"], interval_s=3600))
    assert result["pack_id"] == "fcpack_test"
    assert result["renewal"]["renewal_cycle_days"] == 90
    assert len(recorder.requests) == 2
    assert recorder.requests[0].url.path == "/v1/fleet-check/pack"
    assert json.loads(recorder.requests[0].content) == {
        "origins": ["https://service.example.com"], "interval_s": 3600,
    }
    header = recorder.requests[1].headers["payment-signature"]
    payload = json.loads(base64.b64decode(header))
    assert payload["payload"]["authorization"]["value"] == "5000000"
    assert payload["payload"]["authorization"]["to"] == PAY_TO


def test_fleet_check_sweep_pays_10_cents_and_exposes_log_lines(account):
    delivery = {"summary": {"resources": 2, "ok": 1, "down": 1}, "framework_log": FRAMEWORK_LOG}
    recorder = Recorder(paid_handler(delivery))
    client = make_client(recorder, account)
    result = run(client.fleet_check_sweep(resources=["https://service.example.com/v1/endpoint"]))
    assert framework_log_entries(result) == FRAMEWORK_LOG
    assert framework_log_lines(result) == [e["message"] for e in FRAMEWORK_LOG]
    header = recorder.requests[1].headers["payment-signature"]
    payload = json.loads(base64.b64decode(header))
    assert payload["payload"]["authorization"]["value"] == "100000"


def test_run_fleet_check_sweep_spends_a_credit_plain_call(account):
    delivery = {
        "pack_id": "fcpack_test", "status": "swept",
        "credits_remaining": 99, "framework_log": FRAMEWORK_LOG,
    }
    recorder = Recorder(paid_handler(delivery))
    client = make_client(recorder, account)
    result = run(client.run_fleet_check_sweep("fcpack_test"))
    assert result["credits_remaining"] == 99
    assert len(framework_log_lines(result)) == 2
    assert len(recorder.requests) == 1
    assert "payment-signature" not in recorder.requests[0].headers
    assert json.loads(recorder.requests[0].content) == {"pack_id": "fcpack_test"}


def test_fleet_check_status_free_read(account):
    delivery = {
        "pack_id": "fcpack_test", "credits_remaining": 99,
        "framework_log": FRAMEWORK_LOG,
        "renewal": {"renewal_cycle_days": 90, "days_remaining": 89},
    }
    recorder = Recorder(paid_handler(delivery))
    client = make_client(recorder, account)
    result = run(client.fleet_check_status("fcpack_test"))
    assert result["renewal"]["days_remaining"] == 89
    assert framework_log_entries(result)[1]["defect"] == "server_error"
    assert len(recorder.requests) == 1
    assert "payment-signature" not in recorder.requests[0].headers


def test_buy_pack_refuses_over_price_challenge(account):
    recorder = Recorder(paid_handler({"should": "never arrive"}, amount_override="6000000"))
    client = make_client(recorder, account)
    with pytest.raises(SpendGuardError):
        run(client.buy_fleet_check_pack(origins=["https://service.example.com"]))
    assert all("payment-signature" not in r.headers for r in recorder.requests)


def test_framework_log_helpers_tolerate_missing_log():
    assert framework_log_entries({}) == []
    assert framework_log_entries(None) == []
    assert framework_log_lines(None) == []
