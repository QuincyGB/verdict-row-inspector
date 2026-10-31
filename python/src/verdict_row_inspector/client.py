"""InspectorClient — the Verdict Row inspector surface, paid via x402.

This is the full client the fleet's Inspector Quickstart
(https://stall-row-production.up.railway.app/quickstart/python)
walks by hand, packaged: discover-free reads, the cheap paid routes
on StallRow (Recheck, Sign Reader, Score Book, Guard, Inspector
Physical), RouteVerdict checks, the $1 packs and $5/$20 Fleet
Passes, Fleet-Pass-funded batch rechecks, the hash-chained Recheck
feed v2 with cursor management, watch registration, and self-serve
change-webhook registration.

Payment is NOT hand-rolled here. Paid calls go through the installed
Python x402 SDK — the same library the fleet's own services run
(stall-row pins x402==2.25.0):

    x402Client + ExactEvmScheme (x402.mechanisms.evm.exact.client)
    over an httpx AsyncClient whose transport is
    x402.http.clients.x402_httpx_transport — the transport form of
    wrapHttpxWithPayment, used so callers/tests can inject the inner
    transport. The scheme builds and EIP-712-signs the EIP-3009
    TransferWithAuthorization (exact scheme, Base eip155:8453, USDC).

Spend guard: the x402 client's payment-requirements selector is
ours. Before a paid method runs, the client records that route's cap
— the route's known price from ROUTE_PRICES, lowered by the caller's
max_amount_units ceiling when one is set. The selector refuses (by
raising SpendGuardError) any live 402 accept whose amount exceeds
the cap, BEFORE the scheme creates or signs a payment payload. The
SDK's own default $1 spend control is disabled because this
per-route guard is strictly tighter and knows the $5/$20 pass prices.

Free reads (feed, verdict-read, pack/pass balances, watch and
webhook registration) never need a signer and never pay.

One client serves one caller's calls sequentially; the pending-cap
selector makes concurrent paid calls on a single client unsafe —
use one client per task (the quickstart's own shape).
"""

from __future__ import annotations

import base64
import json
import os
from collections.abc import AsyncGenerator
from pathlib import Path
from typing import Any

import httpx
from eth_account import Account
from eth_account.signers.local import LocalAccount
from x402 import x402Client
from x402.http.clients import x402_httpx_transport
from x402.mechanisms.evm.exact.client import ExactEvmScheme

from .errors import (
    FeedChainError,
    InspectorError,
    PaymentRequiredError,
    SpendGuardError,
)
from .feed import FeedCursor, FeedEnvelope, FeedPage, verify_page

DEFAULT_STALL_ROW_URL = "https://stall-row-production.up.railway.app"
DEFAULT_ROUTE_VERDICT_URL = "https://route-verdict-production.up.railway.app"

BASE_NETWORK = "eip155:8453"
USDC_ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
FLEET_PAY_TO = "0x097f9685D1e0752bF8B02d61E5Ce9be7eA0FBA7F"

# Known per-route prices in USDC micro-units, verified against the
# live /.well-known/x402 discovery documents of both stalls on
# 2026-10-31. The spend guard never signs a challenge priced above
# the route's entry here (a caller ceiling can only lower it).
ROUTE_PRICES: dict[str, int] = {
    "/v1/recheck": 5_000,          # $0.005
    "/v1/sign-read": 10_000,       # $0.01
    "/v1/score-book": 10_000,      # $0.01
    "/v1/guard": 10_000,           # $0.01
    "/v1/physical": 50_000,        # $0.05
    "/v1/recheck/pack": 1_000_000,     # $1.00 — 250 checks, one URL, 90d
    "/v1/toolkit/pack": 1_000_000,     # $1.00 — sign-read/score-book/guard credits
    "/v1/fleet-pass": 5_000_000,       # $5.00
    "/v1/fleet-pass-20": 20_000_000,   # $20.00
}
ROUTE_VERDICT_PRICES: dict[str, int] = {
    "/v1/check": 50_000,           # $0.05
}


def parse_payment_required(response: httpx.Response) -> dict:
    """Parse the x402 v2 challenge from a 402 response: base64 in the
    `payment-required` header, falling back to a same-shaped body."""
    header = response.headers.get("payment-required")
    if header:
        try:
            decoded = json.loads(base64.b64decode(header).decode("utf-8"))
            if isinstance(decoded, dict) and decoded.get("accepts"):
                return decoded
        except (ValueError, UnicodeDecodeError):
            pass
    try:
        body = response.json()
    except ValueError:
        body = None
    if isinstance(body, dict) and body.get("accepts"):
        return body
    raise ValueError("402 response carried no parseable x402 payment challenge")


def load_account_from_env(env: dict | None = None) -> LocalAccount | None:
    """Build the signer from the operator's OWN environment.

    X402_PRIVATE_KEY (the quickstart's name), or AGENT_PRIVATE_KEY /
    AGENT_KEY_FILE (the stall-row-mcp pattern). Returns None when
    nothing is set — a signer-less client can still do every free
    read and raises PaymentRequiredError on paid routes.
    """
    env = os.environ if env is None else env
    key = (env.get("X402_PRIVATE_KEY") or env.get("AGENT_PRIVATE_KEY") or "").strip()
    if not key:
        key_file = (env.get("AGENT_KEY_FILE") or "").strip()
        if key_file:
            key = Path(key_file).read_text(encoding="utf-8").strip()
    if not key:
        return None
    if not key.startswith("0x"):
        key = "0x" + key
    return Account.from_key(key)


def _requirement_amount(requirement: Any) -> int:
    get_amount = getattr(requirement, "get_amount", None)
    if callable(get_amount):
        return int(get_amount())
    return int(requirement.amount)


class InspectorClient:
    """Async client for the Verdict Row inspector surface."""

    def __init__(
        self,
        signer: LocalAccount | str | None = None,
        *,
        stall_row_url: str = DEFAULT_STALL_ROW_URL,
        route_verdict_url: str = DEFAULT_ROUTE_VERDICT_URL,
        max_amount_units: int | None = None,
        timeout: float = 60.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        if isinstance(signer, str):
            key = signer if signer.startswith("0x") else "0x" + signer
            signer = Account.from_key(key)
        self.account: LocalAccount | None = signer
        self.stall_row_url = stall_row_url.rstrip("/")
        self.route_verdict_url = route_verdict_url.rstrip("/")
        # Caller ceiling in micro-USDC; None = each route's known
        # price is its own guard. A set ceiling can only lower a cap.
        self.max_amount_units = max_amount_units
        self.timeout = timeout
        self._transport = transport
        self._pending_cap: int | None = None
        self._pending_path: str | None = None
        self.feed_cursor = FeedCursor()
        self.last_receipt: dict | None = None

        self._x402: x402Client | None = None
        if self.account is not None:
            x402_client = x402Client(self._select_requirement)
            # Our per-route selector guard replaces the SDK's default
            # $1 cap (which would also refuse the $5/$20 passes).
            x402_client.set_spend_controls(False)
            x402_client.register(BASE_NETWORK, ExactEvmScheme(self.account))
            self._x402 = x402_client

    @classmethod
    def from_env(cls, env: dict | None = None, **kwargs: Any) -> "InspectorClient":
        """Client whose signer comes from X402_PRIVATE_KEY /
        AGENT_PRIVATE_KEY / AGENT_KEY_FILE (see load_account_from_env)."""
        return cls(load_account_from_env(env), **kwargs)

    # -- spend guard --------------------------------------------------------

    def _cap_for(self, known_price: int) -> int:
        if self.max_amount_units is not None:
            return min(known_price, self.max_amount_units)
        return known_price

    def _select_requirement(self, version: int, requirements: list) -> Any:
        """x402 payment-requirements selector: pick the exact/Base
        accept, refusing — before any signing — an amount above the
        pending route cap."""
        for req in requirements:
            if req.scheme == "exact" and req.network == BASE_NETWORK:
                amount = _requirement_amount(req)
                if self._pending_cap is not None and amount > self._pending_cap:
                    raise SpendGuardError(
                        {},  # challenge attached by the caller wrapper
                        f"price {amount} exceeds spend guard "
                        f"{self._pending_cap} for {self._pending_path} — "
                        f"refusing to sign",
                    )
                return req
        raise PaymentRequiredError(
            {},
            f"challenge offers no exact requirement on {BASE_NETWORK}: "
            f"{[(r.scheme, r.network) for r in requirements]}",
        )

    # -- transports -----------------------------------------------------------

    def _plain_client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=self._transport, timeout=self.timeout)

    def _paid_client(self) -> httpx.AsyncClient:
        assert self._x402 is not None
        transport = x402_httpx_transport(self._x402, self._transport)
        return httpx.AsyncClient(transport=transport, timeout=self.timeout)

    # -- core calls -----------------------------------------------------------

    async def _post(
        self,
        base_url: str,
        path: str,
        body: dict,
        *,
        known_price: int | None,
        headers: dict | None = None,
        funded: bool = False,
    ) -> dict:
        """POST one route. Paid routes (known_price set, not `funded`)
        go through the x402 transport when a signer exists; a 402 to a
        signer-less client raises PaymentRequiredError with the parsed
        challenge. `funded` calls (pack credit, Fleet Pass header,
        pass-funded batch) are plain POSTs — the credential in the
        body/header is the payment, and a 402 there is an outcome the
        caller must see (e.g. an exhausted pack), never a fallback to
        per-call payment."""
        url = base_url + path
        if known_price is None or funded or self.account is None:
            async with self._plain_client() as http:
                response = await http.post(url, json=body, headers=headers)
            if response.status_code == 402:
                raise PaymentRequiredError(
                    parse_payment_required(response),
                    "endpoint requires x402 payment and no signer is "
                    "configured (or the presented funding credential "
                    "did not cover the call)",
                )
            if response.status_code != 200:
                raise InspectorError(response.status_code, _safe_json(response))
            self.last_receipt = _decode_receipt(response)
            return response.json()

        self._pending_cap = self._cap_for(known_price)
        self._pending_path = path
        try:
            async with self._paid_client() as http:
                response = await http.post(url, json=body, headers=headers)
        except SpendGuardError as exc:
            raise SpendGuardError(
                exc.challenge, str(exc)
            ) from exc
        except Exception as exc:  # the x402 transport wraps hook errors
            guard = _find_guard_error(exc)
            if guard is not None:
                raise guard
            raise
        finally:
            self._pending_cap = None
            self._pending_path = None
        if response.status_code == 402:
            raise PaymentRequiredError(
                parse_payment_required(response),
                "paid retry still returned 402 (payment rejected or expired)",
            )
        if response.status_code != 200:
            raise InspectorError(response.status_code, _safe_json(response))
        self.last_receipt = _decode_receipt(response)
        return response.json()

    async def _get(self, base_url: str, path: str, params: dict) -> httpx.Response:
        async with self._plain_client() as http:
            response = await http.get(base_url + path, params=params)
        if response.status_code != 200:
            raise InspectorError(response.status_code, _safe_json(response))
        return response

    # -- paid inspector routes (StallRow) --------------------------------------

    async def recheck(
        self,
        url: str,
        watch_id: str | None = None,
        pack_id: str | None = None,
        fleet_pass_id: str | None = None,
    ) -> dict:
        """POST /v1/recheck ($0.005): fingerprint one x402 resource or
        web page; first sight = BASELINE, later calls diff. With a
        pack_id the call spends one pack credit instead of paying;
        with fleet_pass_id it debits the pass — both are `funded`."""
        body: dict[str, Any] = {"url": url}
        if watch_id:
            body["watch_id"] = watch_id
        if pack_id:
            body["pack_id"] = pack_id
        headers = {"X-Fleet-Pass": fleet_pass_id} if fleet_pass_id else None
        return await self._post(
            self.stall_row_url, "/v1/recheck", body,
            known_price=ROUTE_PRICES["/v1/recheck"],
            headers=headers, funded=bool(pack_id or fleet_pass_id),
        )

    async def sign_read(
        self,
        url: str,
        declared_method: str | None = None,
        declared_amount: str | None = None,
        declared_pay_to: str | None = None,
        declared_network: str | None = None,
        pack_id: str | None = None,
    ) -> dict:
        """POST /v1/sign-read ($0.01): parse one endpoint's 402 sign +
        SDK-compatibility verdict, with declared-vs-live mismatches."""
        body: dict[str, Any] = {"url": url}
        for key, value in (
            ("declared_method", declared_method),
            ("declared_amount", declared_amount),
            ("declared_pay_to", declared_pay_to),
            ("declared_network", declared_network),
            ("pack_id", pack_id),
        ):
            if value:
                body[key] = value
        return await self._post(
            self.stall_row_url, "/v1/sign-read", body,
            known_price=ROUTE_PRICES["/v1/sign-read"], funded=bool(pack_id),
        )

    async def score_book(
        self,
        url: str | None = None,
        origin: str | None = None,
        pay_to: str | None = None,
        pack_id: str | None = None,
    ) -> dict:
        """POST /v1/score-book ($0.01): recorded track record for
        exactly one of url / origin / pay_to."""
        body: dict[str, Any] = {}
        for key, value in (("url", url), ("origin", origin), ("pay_to", pay_to), ("pack_id", pack_id)):
            if value:
                body[key] = value
        return await self._post(
            self.stall_row_url, "/v1/score-book", body,
            known_price=ROUTE_PRICES["/v1/score-book"], funded=bool(pack_id),
        )

    async def guard(self, url: str, pack_id: str | None = None) -> dict:
        """POST /v1/guard ($0.01): one PROCEED / CAUTION / ABORT
        verdict before you pay an endpoint."""
        body: dict[str, Any] = {"url": url}
        if pack_id:
            body["pack_id"] = pack_id
        return await self._post(
            self.stall_row_url, "/v1/guard", body,
            known_price=ROUTE_PRICES["/v1/guard"], funded=bool(pack_id),
        )

    async def physical(self, url: str, watch_id: str | None = None) -> dict:
        """POST /v1/physical ($0.05): Inspector Physical — sign-read +
        score-book + guard + recheck on one target in one call. Pack
        credits do NOT fund this bundle (the service refuses them);
        pay per call or via a Fleet Pass header on a raw call."""
        body: dict[str, Any] = {"url": url}
        if watch_id:
            body["watch_id"] = watch_id
        return await self._post(
            self.stall_row_url, "/v1/physical", body,
            known_price=ROUTE_PRICES["/v1/physical"],
        )

    # -- RouteVerdict ---------------------------------------------------------

    async def route_verdict(self, resource_url: str) -> dict:
        """POST RouteVerdict /v1/check ($0.05): TRUSTED / CAUTION /
        AVOID verdict + 0–100 score for any paid resource URL."""
        return await self._post(
            self.route_verdict_url, "/v1/check", {"resource_url": resource_url},
            known_price=ROUTE_VERDICT_PRICES["/v1/check"],
        )

    # -- packs + passes (paid mints) -------------------------------------------

    async def buy_recheck_pack(self, url: str) -> dict:
        """POST /v1/recheck/pack ($1.00): mint 250 Recheck credits
        bound to one URL for 90 days. Spend with recheck(pack_id=...);
        balance via recheck_pack_balance()."""
        return await self._post(
            self.stall_row_url, "/v1/recheck/pack", {"url": url},
            known_price=ROUTE_PRICES["/v1/recheck/pack"],
        )

    async def buy_toolkit_pack(self) -> dict:
        """POST /v1/toolkit/pack ($1.00): mint a toolkit pack whose
        credits spend on sign-read / score-book / guard."""
        return await self._post(
            self.stall_row_url, "/v1/toolkit/pack", {},
            known_price=ROUTE_PRICES["/v1/toolkit/pack"],
        )

    async def buy_fleet_pass(self, tier: int | str = 5) -> dict:
        """POST /v1/fleet-pass ($5) or /v1/fleet-pass-20 ($20): mint a
        prepaid Fleet Pass. Spend it with the X-Fleet-Pass header —
        each call debits that route's listed price."""
        tier_value = str(tier).replace("$", "").strip()
        if tier_value in ("5", "5.00", "fleet-pass"):
            path = "/v1/fleet-pass"
        elif tier_value in ("20", "20.00", "fleet-pass-20"):
            path = "/v1/fleet-pass-20"
        else:
            raise ValueError(f"unknown fleet pass tier {tier!r} — use 5 or 20")
        return await self._post(
            self.stall_row_url, path, {}, known_price=ROUTE_PRICES[path],
        )

    # -- Fleet-Pass-funded batch -------------------------------------------------

    async def batch_recheck(self, urls: list[str], fleet_pass_id: str) -> dict:
        """POST /v1/recheck/batch: one Recheck per unique URL (max
        100), Fleet-Pass-funded ONLY ($0.005/check debited once up
        front; exactly 100 unique URLs get the 20% batch discount).
        Not an x402-priced route — no signer is used."""
        return await self._post(
            self.stall_row_url, "/v1/recheck/batch",
            {"urls": list(urls), "fleet_pass_id": fleet_pass_id},
            known_price=None, funded=True,
            headers={"X-Fleet-Pass": fleet_pass_id},
        )

    # -- free reads ---------------------------------------------------------------

    async def pass_balance(self, pass_id: str) -> dict:
        """POST /v1/fleet-pass/balance (free holder read): balance,
        tier, expiry and debit history for one Fleet Pass."""
        return await self._post(
            self.stall_row_url, "/v1/fleet-pass/balance", {"pass_id": pass_id},
            known_price=None,
        )

    async def recheck_pack_balance(self, pack_id: str) -> dict:
        """POST /v1/recheck/pack-balance (free): credits remaining +
        expiry for a Recheck pack."""
        return await self._post(
            self.stall_row_url, "/v1/recheck/pack-balance", {"pack_id": pack_id},
            known_price=None,
        )

    async def toolkit_pack_balance(self, pack_id: str) -> dict:
        """POST /v1/toolkit/pack-balance (free)."""
        return await self._post(
            self.stall_row_url, "/v1/toolkit/pack-balance", {"pack_id": pack_id},
            known_price=None,
        )

    async def verdict_read(self, url: str) -> dict:
        """GET /v1/verdict-read (free): the recorded state this
        service already holds for one resource URL — latest recorded
        check, recorded terms, Score Book aggregates, last CHANGED
        event, and a verdict only where one is honestly recorded.
        Never probes or pays the target."""
        response = await self._get(
            self.stall_row_url, "/v1/verdict-read", {"url": url}
        )
        return response.json()

    # -- feed v2 -------------------------------------------------------------------

    async def feed_page(
        self,
        since_seq: int = 0,
        *,
        limit: int | None = None,
        origin: str | None = None,
        pay_to: str | None = None,
        route: str | None = None,
        url: str | None = None,
        watch_id: str | None = None,
        verify: bool = True,
    ) -> FeedPage:
        """One page of GET /v1/recheck/feed?v=2 (free): envelopes with
        seq > since_seq, ascending. Hash-chain verification runs per
        envelope always; seq-continuity + prev_hash linkage are also
        enforced for unfiltered pages (filtered pages are subsets of
        the same chain — gaps there are expected, see feed.py)."""
        params: dict[str, Any] = {"v": "2", "since_seq": since_seq}
        for key, value in (
            ("limit", limit), ("origin", origin), ("pay_to", pay_to),
            ("route", route), ("url", url), ("watch_id", watch_id),
        ):
            if value is not None:
                params[key] = value
        response = await self._get(self.stall_row_url, "/v1/recheck/feed", params)
        envelopes = [
            FeedEnvelope.from_json(json.loads(line))
            for line in response.text.splitlines()
            if line.strip()
        ]
        filtered = any(
            v is not None for v in (origin, pay_to, route, url, watch_id)
        )
        if verify:
            verify_page(
                envelopes,
                contiguous=not filtered,
                after_seq=since_seq,
                prev_hash=None,
            )
        page = FeedPage(
            envelopes=envelopes,
            latest_seq=_int_header(response, "X-Recheck-Feed-Latest-Seq"),
            earliest_seq=_int_header(response, "X-Recheck-Feed-Earliest-Seq"),
            feed_count=_int_header(response, "X-Recheck-Feed-Count"),
        )
        return page

    async def feed(
        self,
        since_seq: int | None = None,
        *,
        page_limit: int = 200,
        origin: str | None = None,
        pay_to: str | None = None,
        route: str | None = None,
        url: str | None = None,
        watch_id: str | None = None,
        max_pages: int | None = None,
        verify: bool = True,
    ) -> AsyncGenerator[FeedEnvelope, None]:
        """Cursor-managed feed walk: yields envelopes from
        `since_seq` (default: the client's stored feed_cursor, else 0)
        forward, page by page, verifying the chain as it goes and
        advancing self.feed_cursor after every envelope. Persist
        client.feed_cursor between runs to resume gap-proof.

        Chain verification across page boundaries is enforced for
        unfiltered walks (seq continuity + prev_hash linkage against
        the cursor's last hash). A filtered walk verifies each
        envelope's hash but expects seq gaps."""
        filtered = any(
            v is not None for v in (origin, pay_to, route, url, watch_id)
        )
        cursor = since_seq if since_seq is not None else self.feed_cursor.seq
        link = self.feed_cursor.last_hash if since_seq is None else None
        pages = 0
        while True:
            page = await self.feed_page(
                cursor, limit=page_limit, origin=origin, pay_to=pay_to,
                route=route, url=url, watch_id=watch_id, verify=False,
            )
            if verify:
                verify_page(
                    page.envelopes,
                    contiguous=not filtered,
                    after_seq=cursor,
                    prev_hash=link,
                )
            for env in page.envelopes:
                self.feed_cursor.advance(env)
                cursor = env.seq
                link = env.record_hash
                yield env
            pages += 1
            if len(page.envelopes) < page_limit:
                return
            if max_pages is not None and pages >= max_pages:
                return

    # -- standing pushes (registration free; runs spend funding) ---------------------

    async def watch_register(
        self,
        url: str,
        webhook_url: str | None = None,
        *,
        email: str | None = None,
        interval_s: int | None = None,
        pack_id: str | None = None,
        fleet_pass_id: str | None = None,
        check_kind: str = "recheck",
    ) -> dict:
        """POST /v1/watch/register (free to register): standing
        Recheck (or RouteVerdict, check_kind="route_verdict",
        Fleet-Pass-only) runs on your interval, pushing BASELINE /
        CHANGED to your webhook. Exactly one funding credential:
        pack_id (bound to the watched URL) or fleet_pass_id."""
        body: dict[str, Any] = {"url": url, "check_kind": check_kind}
        for key, value in (
            ("webhook_url", webhook_url), ("email", email),
            ("interval_s", interval_s), ("pack_id", pack_id),
            ("fleet_pass_id", fleet_pass_id),
        ):
            if value is not None:
                body[key] = value
        return await self._post(
            self.stall_row_url, "/v1/watch/register", body, known_price=None,
        )

    async def webhook_register(
        self,
        callback_url: str,
        secret: str,
        *,
        url: str | None = None,
        origin: str | None = None,
        pack_id: str | None = None,
        fleet_pass_id: str | None = None,
    ) -> dict:
        """POST /v1/recheck/webhooks (registration free; pack/pass
        gated): subscribe to Recheck CHANGED events — feed-wide, one
        URL, or one origin. Deliveries are HMAC-SHA256 signed with
        `secret` (16+ chars); verify them with
        verdict_row_inspector.verify_webhook_signature. Exactly one
        funding credential is required; a pack-funded subscription
        must filter to exactly the pack's URL."""
        body: dict[str, Any] = {"callback_url": callback_url, "secret": secret}
        for key, value in (
            ("url", url), ("origin", origin),
            ("pack_id", pack_id), ("fleet_pass_id", fleet_pass_id),
        ):
            if value is not None:
                body[key] = value
        return await self._post(
            self.stall_row_url, "/v1/recheck/webhooks", body, known_price=None,
        )

    async def webhook_list(self, secret: str) -> dict:
        """POST /v1/recheck/webhooks/list (free; the secret is the
        management credential)."""
        return await self._post(
            self.stall_row_url, "/v1/recheck/webhooks/list",
            {"secret": secret}, known_price=None,
        )

    async def webhook_delete(self, secret: str, sub_id: str) -> dict:
        """POST /v1/recheck/webhooks/delete (free)."""
        return await self._post(
            self.stall_row_url, "/v1/recheck/webhooks/delete",
            {"secret": secret, "sub_id": sub_id}, known_price=None,
        )


def _find_guard_error(exc: BaseException) -> SpendGuardError | None:
    """The x402 transport wraps selector errors; unwrap ours."""
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current, SpendGuardError):
            return current
        current = current.__cause__ or current.__context__
    return None


def _decode_receipt(response: httpx.Response) -> dict | None:
    raw = response.headers.get("payment-response")
    if not raw:
        return None
    try:
        return json.loads(base64.b64decode(raw).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None


def _int_header(response: httpx.Response, name: str) -> int | None:
    raw = response.headers.get(name)
    return int(raw) if raw is not None else None


def _safe_json(response: httpx.Response) -> Any:
    try:
        return response.json()
    except ValueError:
        return response.text[:500]
