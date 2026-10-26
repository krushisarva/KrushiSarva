"""Google OAuth for YouTube: refresh-token exchange and the one-time `ksm auth-youtube` flow.

The installed-app flow uses a loopback redirect on 127.0.0.1 (random port) with PKCE,
access_type=offline and prompt=consent, so Google always returns a refresh token.
It must be run while signed in as the channel OWNER: invited Studio managers cannot
authorise YouTube API access.
"""
from __future__ import annotations

import base64
import hashlib
import json
import secrets as pysecrets
import threading
import time
import webbrowser
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Callable
from urllib.parse import parse_qs, urlencode, urlparse

import httpx

from .common import TIMEOUT

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels"
SCOPES = (
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/yt-analytics.readonly",
)
CLIENT_SECRET_NAME = "youtube_client_json"
REFRESH_SECRET_NAME = "youtube_refresh_token"


class AuthError(Exception):
    """transient=True: try again later (network/5xx); False: needs `ksm auth-youtube`."""

    def __init__(self, message: str, *, transient: bool = False):
        super().__init__(message)
        self.transient = transient


def parse_client_json(raw: str | dict) -> tuple[str, str]:
    """Desktop-client JSON from Google Cloud ({"installed": {...}}) -> (client_id, client_secret)."""
    d = json.loads(raw) if isinstance(raw, str) else raw
    d = d.get("installed") or d.get("web") or d
    try:
        return d["client_id"], d["client_secret"]
    except KeyError as e:
        raise AuthError(f"youtube_client_json lacks {e.args[0]}") from None


class GoogleAuth:
    """Caches an access token; refreshes it from the stored refresh token when needed.

    Credentials come from `loader` lazily so constructing a publisher (e.g. in dry-run)
    never touches the Keychain.
    """

    def __init__(self, http: httpx.Client, loader: Callable[[], tuple[str, str, str]], *,
                 clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc)):
        self.http = http
        self._loader = loader
        self._clock = clock
        self._token: str | None = None
        self._expires: datetime | None = None

    @classmethod
    def from_secrets(cls, http: httpx.Client) -> "GoogleAuth":
        def load() -> tuple[str, str, str]:
            from ..secrets import get_secret  # lazy: core module, Keychain access

            cid, csec = parse_client_json(get_secret(CLIENT_SECRET_NAME))
            return cid, csec, get_secret(REFRESH_SECRET_NAME)
        return cls(http, load)

    def access_token(self, force: bool = False) -> str:
        now = self._clock()
        if not force and self._token and self._expires and now < self._expires:
            return self._token
        client_id, client_secret, refresh = self._loader()
        try:
            resp = self.http.post(TOKEN_URL, timeout=TIMEOUT, data={
                "grant_type": "refresh_token", "refresh_token": refresh,
                "client_id": client_id, "client_secret": client_secret,
            })
        except httpx.TransportError as e:
            raise AuthError(f"token endpoint unreachable: {e!r}", transient=True) from e
        if resp.status_code >= 500 or resp.status_code == 429:
            raise AuthError(f"token endpoint HTTP {resp.status_code}", transient=True)
        if not resp.is_success:
            err = _json(resp).get("error", "")
            raise AuthError(f"refresh failed ({resp.status_code} {err}); run `ksm auth-youtube`")
        body = resp.json()
        self._token = body["access_token"]
        # Refresh a minute early so a token never expires mid-request.
        self._expires = now + timedelta(seconds=int(body.get("expires_in", 3600)) - 60)
        return self._token


def _json(resp: httpx.Response) -> dict:
    try:
        return resp.json()
    except ValueError:
        return {}


# ── One-time installed-app flow ───────────────────────────────────────────────


def pkce_pair() -> tuple[str, str]:
    verifier = base64.urlsafe_b64encode(pysecrets.token_bytes(48)).rstrip(b"=").decode()
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


def build_auth_url(client_id: str, redirect_uri: str, state: str, challenge: str) -> str:
    return AUTH_URL + "?" + urlencode({
        "client_id": client_id, "redirect_uri": redirect_uri, "response_type": "code",
        "scope": " ".join(SCOPES), "access_type": "offline", "prompt": "consent",
        "include_granted_scopes": "true", "state": state,
        "code_challenge": challenge, "code_challenge_method": "S256",
    })


_DONE_HTML = ("<html><body><h3>KrushiSarva: YouTube access granted. You can close this tab.</h3>"
              "</body></html>").encode()


def _wait_for_code(server: HTTPServer, state: str, timeout_s: float) -> str:
    result: dict[str, str] = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 - stdlib API
            q = parse_qs(urlparse(self.path).query)
            if "code" not in q and "error" not in q:
                # Stray request (e.g. the browser's /favicon.ico): not the redirect, keep waiting.
                self.send_response(404)
                self.end_headers()
                return
            if q.get("state", [""])[0] != state:
                result.setdefault("error", "state mismatch")
            elif "error" in q:
                result["error"] = q["error"][0]
            elif "code" in q:
                result["code"] = q["code"][0]
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(_DONE_HTML if "code" in result else b"Authorisation failed.")

        def log_message(self, *args: Any) -> None:  # keep the code out of logs
            pass

    server.RequestHandlerClass = Handler
    server.timeout = 1.0
    deadline = time.monotonic() + timeout_s
    while "code" not in result and "error" not in result:
        if time.monotonic() > deadline:
            raise AuthError("timed out waiting for the browser redirect")
        server.handle_request()
    if "error" in result:
        raise AuthError(f"authorisation failed: {result['error']}")
    return result["code"]


def run_installed_flow(client_id: str, client_secret: str, http: httpx.Client, *,
                       open_browser: Callable[[str], Any] = webbrowser.open,
                       timeout_s: float = 300.0) -> dict:
    """Runs the loopback consent flow; returns Google's token response (with refresh_token)."""
    verifier, challenge = pkce_pair()
    state = pysecrets.token_urlsafe(24)
    server = HTTPServer(("127.0.0.1", 0), BaseHTTPRequestHandler)
    try:
        redirect_uri = f"http://127.0.0.1:{server.server_port}/"
        url = build_auth_url(client_id, redirect_uri, state, challenge)
        threading.Thread(target=open_browser, args=(url,), daemon=True).start()
        code = _wait_for_code(server, state, timeout_s)
    finally:
        server.server_close()
    resp = http.post(TOKEN_URL, timeout=TIMEOUT, data={
        "grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri,
        "client_id": client_id, "client_secret": client_secret, "code_verifier": verifier,
    })
    if not resp.is_success:
        raise AuthError(f"code exchange failed: HTTP {resp.status_code} {_json(resp).get('error', '')}")
    tokens = resp.json()
    if not tokens.get("refresh_token"):
        raise AuthError("Google returned no refresh_token; revoke the app's access and retry")
    return tokens


def verify_channel(http: httpx.Client, access_token: str) -> dict:
    """channels.list mine=true -> {"id","title"}. Also serves as the daily token health check."""
    resp = http.get(CHANNELS_URL, timeout=TIMEOUT, params={"part": "snippet", "mine": "true"},
                    headers={"Authorization": f"Bearer {access_token}"})
    if not resp.is_success:
        raise AuthError(f"channels.list failed: HTTP {resp.status_code}", transient=resp.status_code >= 500)
    items = resp.json().get("items") or []
    if not items:
        raise AuthError("this Google account owns no YouTube channel; sign in as the channel owner")
    return {"id": items[0]["id"], "title": items[0].get("snippet", {}).get("title", "")}


def auth_youtube(http: httpx.Client | None = None, *, open_browser: Callable[[str], Any] = webbrowser.open,
                 expected_channel_id: str | None = None, timeout_s: float = 300.0) -> dict:
    """`ksm auth-youtube`: consent, verify the channel, then store the refresh token."""
    from ..secrets import get_secret, set_secret  # lazy: core module

    own = http is None
    http = http or httpx.Client(timeout=TIMEOUT)
    try:
        client_id, client_secret = parse_client_json(get_secret(CLIENT_SECRET_NAME))
        tokens = run_installed_flow(client_id, client_secret, http, open_browser=open_browser, timeout_s=timeout_s)
        channel = verify_channel(http, tokens["access_token"])
        if expected_channel_id and channel["id"] != expected_channel_id:
            raise AuthError(f"authorised channel {channel['id']} is not the expected {expected_channel_id}")
        set_secret(REFRESH_SECRET_NAME, tokens["refresh_token"])
        return channel
    finally:
        if own:
            http.close()
