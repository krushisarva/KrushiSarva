from __future__ import annotations

import urllib.error
import urllib.request
from datetime import timedelta
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
import respx

from ksm.publish import build_publishers
from ksm.publish.common import (DryRunPublisher, PublishError, caption_for, fail, load_pub, record_intent,
                                record_result)
from ksm.publish.oauth import (AuthError, GoogleAuth, SCOPES, build_auth_url, parse_client_json, pkce_pair,
                               run_installed_flow, verify_channel)

from _publish_fixtures import T0, events, make_db, make_settings, morning_slot

SETTINGS = make_settings()
SLOT = morning_slot(SETTINGS)


# ── Bookkeeping ───────────────────────────────────────────────────────────────


def test_record_intent_and_result(tmp_path):
    conn, rev, pubs = make_db(tmp_path, ("yt",))
    record_intent(conn, pubs["yt"], upload_session_uri="https://x", state="UPLOADING", last_error="old")
    record_result(conn, pubs["yt"], state="SCHEDULED", remote_id="V1", scheduled_for=SLOT.publish_at)
    row = load_pub(conn, pubs["yt"])
    assert row["upload_session_uri"] == "https://x" and row["remote_id"] == "V1"
    assert row["scheduled_for"] == SLOT.publish_at.isoformat() and row["last_error"] is None
    assert events(conn, "publish_state")[-1]["state"] == "SCHEDULED"
    with pytest.raises(ValueError):
        record_intent(conn, pubs["yt"], video_id=5)


def test_backoff_schedule_and_fatal(tmp_path):
    conn, _, pubs = make_db(tmp_path, ("yt",))
    seen = []
    for _ in range(6):
        state = fail(conn, pubs["yt"], PublishError("boom"), T0)
        row = load_pub(conn, pubs["yt"])
        seen.append((state, row["next_attempt_at"]))
    assert [s for s, _ in seen] == ["RETRY"] * 5 + ["FATAL"]
    assert seen[0][1] == (T0 + timedelta(minutes=1)).isoformat()
    assert seen[1][1] == (T0 + timedelta(minutes=5)).isoformat()
    assert seen[2][1] == (T0 + timedelta(minutes=30)).isoformat()
    assert seen[3][1] == seen[4][1] == (T0 + timedelta(hours=2)).isoformat()
    assert events(conn, "alert")


def test_caption_composition():
    rev = {"metadata_json": '{"ig": {"caption": "भाव #सोयाबीन", "hashtags": ["#सोयाबीन", "बाजारभाव"]}}'}
    cap = caption_for(rev, "ig")
    assert cap.count("#सोयाबीन") == 1 and "#बाजारभाव" in cap and cap.endswith("AI आवाज")


# ── Dry run ───────────────────────────────────────────────────────────────────


def test_dry_run_makes_no_calls_and_logs(tmp_path):
    with respx.mock() as router:   # any request would fail: nothing is mocked
        conn, rev, pubs = make_db(tmp_path)
        pubs_map = build_publishers(make_settings(dry_run=True), httpx.Client())
        assert all(isinstance(p, DryRunPublisher) for p in pubs_map.values())
        got = {k: p.ensure(conn, load_pub(conn, pubs[k]), rev, now=T0, slot=SLOT) for k, p in pubs_map.items()}
        assert got == {"yt": "SCHEDULED", "fb": "SCHEDULED", "ig": "PUBLISH_DUE"}
        # IG publishes (in dry run) once the slot arrives; repeated calls do not log again.
        ig = pubs_map["ig"]
        assert ig.ensure(conn, load_pub(conn, pubs["ig"]), rev, now=SLOT.publish_at, slot=SLOT) == "PUBLISHED"
        assert ig.ensure(conn, load_pub(conn, pubs["ig"]), rev, now=SLOT.publish_at, slot=SLOT) == "PUBLISHED"
        logged = events(conn, "dry_run")
        assert len(logged) == 4 and not router.calls
        yt = next(e for e in logged if e["platform"] == "yt")
        assert yt["requests"][0]["json"]["status"]["containsSyntheticMedia"] is True
        assert "access_token" not in str(logged)


def test_build_publishers_respects_platforms():
    pubs = build_publishers(make_settings(platforms=["yt"]), httpx.Client(), dry_run=False)
    assert list(pubs) == ["yt"]


# ── OAuth ─────────────────────────────────────────────────────────────────────


def test_parse_client_json():
    assert parse_client_json('{"installed": {"client_id": "a", "client_secret": "b"}}') == ("a", "b")
    with pytest.raises(AuthError):
        parse_client_json({"installed": {"client_id": "a"}})


def test_access_token_cached_and_refreshed():
    clock = [T0]
    with respx.mock() as router:
        route = router.post("https://oauth2.googleapis.com/token").mock(
            return_value=httpx.Response(200, json={"access_token": "AT", "expires_in": 3600}))
        auth = GoogleAuth(httpx.Client(), lambda: ("c", "s", "r"), clock=lambda: clock[0])
        assert auth.access_token() == "AT" and auth.access_token() == "AT"
        assert route.call_count == 1
        body = parse_qs(route.calls[0].request.content.decode())
        assert body["grant_type"] == ["refresh_token"] and body["refresh_token"] == ["r"]
        clock[0] = T0 + timedelta(minutes=59, seconds=30)
        auth.access_token()
        assert route.call_count == 2
        auth.access_token(force=True)
        assert route.call_count == 3


def test_invalid_grant_is_not_transient():
    with respx.mock() as router:
        router.post("https://oauth2.googleapis.com/token").mock(
            return_value=httpx.Response(400, json={"error": "invalid_grant"}))
        with pytest.raises(AuthError) as ei:
            GoogleAuth(httpx.Client(), lambda: ("c", "s", "r")).access_token()
        assert not ei.value.transient and "auth-youtube" in str(ei.value)


def test_auth_url_has_offline_consent_pkce():
    verifier, challenge = pkce_pair()
    assert 43 <= len(verifier) <= 128 and challenge != verifier
    q = parse_qs(urlparse(build_auth_url("cid", "http://127.0.0.1:5000/", "st", challenge)).query)
    assert q["access_type"] == ["offline"] and q["prompt"] == ["consent"]
    assert q["code_challenge_method"] == ["S256"] and q["scope"][0].split() == list(SCOPES)


def test_installed_flow_loopback():
    def fake_browser(url: str) -> None:
        q = parse_qs(urlparse(url).query)
        redirect = q["redirect_uri"][0]
        assert redirect.startswith("http://127.0.0.1:")
        urllib.request.urlopen(f"{redirect}?state={q['state'][0]}&code=CODE123", timeout=5).read()

    with respx.mock() as router:
        route = router.post("https://oauth2.googleapis.com/token").mock(return_value=httpx.Response(
            200, json={"access_token": "AT", "refresh_token": "RT", "expires_in": 3600}))
        tokens = run_installed_flow("cid", "csec", httpx.Client(), open_browser=fake_browser, timeout_s=10)
        assert tokens["refresh_token"] == "RT"
        body = parse_qs(route.calls[0].request.content.decode())
        assert body["code"] == ["CODE123"] and body["grant_type"] == ["authorization_code"]
        assert body["code_verifier"][0]


def test_installed_flow_rejects_wrong_state():
    def fake_browser(url: str) -> None:
        redirect = parse_qs(urlparse(url).query)["redirect_uri"][0]
        urllib.request.urlopen(f"{redirect}?state=evil&code=X", timeout=5).read()

    with respx.mock():
        with pytest.raises(AuthError, match="state"):
            run_installed_flow("cid", "csec", httpx.Client(), open_browser=fake_browser, timeout_s=10)


def test_verify_channel():
    with respx.mock() as router:
        router.get("https://www.googleapis.com/youtube/v3/channels").mock(return_value=httpx.Response(
            200, json={"items": [{"id": "UC1", "snippet": {"title": "KrushiSarva"}}]}))
        assert verify_channel(httpx.Client(), "AT") == {"id": "UC1", "title": "KrushiSarva"}
        router.get("https://www.googleapis.com/youtube/v3/channels").mock(return_value=httpx.Response(
            200, json={"items": []}))
        with pytest.raises(AuthError):
            verify_channel(httpx.Client(), "AT")



# ── Review fixes ──────────────────────────────────────────────────────────────


def test_transient_error_never_regresses_a_confirmed_post(tmp_path):
    conn, _, pubs = make_db(tmp_path, ("fb",))
    record_result(conn, pubs["fb"], state="SCHEDULED", remote_id="FV1", scheduled_for=SLOT.publish_at)
    assert fail(conn, pubs["fb"], PublishError("graph 500"), T0) == "SCHEDULED"
    row = load_pub(conn, pubs["fb"])
    assert row["state"] == "SCHEDULED" and row["next_attempt_at"] == (T0 + timedelta(minutes=1)).isoformat()
    assert fail(conn, pubs["fb"], PublishError("rejected", fatal=True), T0) == "FATAL"


def test_dry_run_with_bad_metadata_fails_instead_of_raising(tmp_path):
    with respx.mock() as router:
        conn, rev, pubs = make_db(tmp_path, ("yt",))
        rev = dict(rev) | {"metadata_json": '{"yt": {"title": ""}}'}
        yt = build_publishers(make_settings(dry_run=True, platforms=["yt"]), httpx.Client())["yt"]
        assert yt.ensure(conn, load_pub(conn, pubs["yt"]), rev, now=T0, slot=SLOT) == "FATAL"
        assert events(conn, "alert") and not events(conn, "dry_run") and not router.calls


def test_installed_flow_ignores_stray_requests():
    def fake_browser(url: str) -> None:
        q = parse_qs(urlparse(url).query)
        redirect = q["redirect_uri"][0]
        with pytest.raises(urllib.error.HTTPError):   # the browser's favicon probe comes first
            urllib.request.urlopen(f"{redirect}favicon.ico", timeout=5)
        urllib.request.urlopen(f"{redirect}?state={q['state'][0]}&code=CODE123", timeout=5).read()

    with respx.mock() as router:
        router.post("https://oauth2.googleapis.com/token").mock(return_value=httpx.Response(
            200, json={"access_token": "AT", "refresh_token": "RT", "expires_in": 3600}))
        assert run_installed_flow("cid", "csec", httpx.Client(), open_browser=fake_browser,
                                  timeout_s=10)["refresh_token"] == "RT"
