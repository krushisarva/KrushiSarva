from __future__ import annotations

from dataclasses import replace
from datetime import timedelta

import httpx
import pytest
import respx

from ksm.db import parse_iso
from ksm.publish.common import MetaSession, load_pub, record_result
from ksm.publish.meta_fb import FacebookPublisher
from ksm.publish.meta_ig import InstagramPublisher

from _publish_fixtures import T0, FakeMeta, drive, events, make_db, make_settings, morning_slot

SETTINGS = make_settings()
SLOT = morning_slot(SETTINGS)   # 2026-10-17 01:30 UTC, late_until 04:30 UTC


def fb_factory(http, settings=SETTINGS):
    return lambda: FacebookPublisher(http, MetaSession(http, lambda: "SYS"), settings)


def ig_factory(http, settings=SETTINGS):
    return lambda: InstagramPublisher(http, MetaSession(http, lambda: "SYS"), settings)


@pytest.fixture
def env(tmp_path):
    with respx.mock(assert_all_called=False) as router:
        fake = FakeMeta(router)
        conn, rev, pubs = make_db(tmp_path, ("fb", "ig"))
        yield fake, conn, rev, pubs, httpx.Client()


# ── Facebook ──────────────────────────────────────────────────────────────────


def test_fb_scheduled_reel(env):
    fake, conn, rev, pubs, http = env
    assert fb_factory(http)().ensure(conn, load_pub(conn, pubs["fb"]), rev, now=T0, slot=SLOT) == "SCHEDULED"
    p = fake.fb_finish_params[0]
    assert p["video_state"] == "SCHEDULED" and int(p["scheduled_publish_time"]) == int(SLOT.publish_at.timestamp())
    assert "is_ai_generated" not in p          # not until day-0 confirms the flag
    assert "AI आवाज" in p["description"] and "#सोयाबीन" in p["description"]
    row = load_pub(conn, pubs["fb"])
    assert row["remote_id"] == row["container_id"] == "FV1"
    assert row["permalink"] == "https://www.facebook.com/reel/FV1"


def test_fb_ai_flag_and_publish_now(env):
    fake, conn, rev, pubs, http = env
    settings = make_settings(meta={"fb_ai_flag_supported": True})
    now = SLOT.publish_at - timedelta(minutes=5)
    assert fb_factory(http, settings)().ensure(conn, load_pub(conn, pubs["fb"]), rev, now=now, slot=SLOT) == "PUBLISHED"
    p = fake.fb_finish_params[0]
    assert p["video_state"] == "PUBLISHED" and p["is_ai_generated"] == "true"
    assert "scheduled_publish_time" not in p


def test_fb_verify(env):
    fake, conn, rev, pubs, http = env
    pub = fb_factory(http)()
    pub.ensure(conn, load_pub(conn, pubs["fb"]), rev, now=T0, slot=SLOT)
    fake.fb_videos["FV1"]["finish"] = {**fake.fb_videos["FV1"]["finish"], "video_state": "PUBLISHED"}
    later = SLOT.publish_at + timedelta(minutes=6)
    assert pub.ensure(conn, load_pub(conn, pubs["fb"]), rev, now=later, slot=SLOT) == "VERIFIED"


def test_fb_token_error_is_fatal_with_alert(tmp_path):
    with respx.mock() as router:
        router.get("https://graph.facebook.com/v26.0/me/accounts").mock(return_value=httpx.Response(
            400, json={"error": {"code": 190, "message": "Error validating access token"}}))
        conn, rev, pubs = make_db(tmp_path, ("fb",))
        state = fb_factory(httpx.Client())().ensure(conn, load_pub(conn, pubs["fb"]), rev, now=T0, slot=SLOT)
        assert state == "FATAL"
        assert events(conn, "alert")


def test_fb_server_errors_back_off_then_fatal(tmp_path):
    with respx.mock() as router:
        router.route(host="graph.facebook.com").mock(return_value=httpx.Response(500, json={"error": {"code": 2}}))
        conn, rev, pubs = make_db(tmp_path, ("fb",))
        pub, now, delays = fb_factory(httpx.Client())(), T0, []
        for _ in range(6):
            state = pub.ensure(conn, load_pub(conn, pubs["fb"]), rev, now=now, slot=SLOT)
            row = load_pub(conn, pubs["fb"])
            if state == "FATAL":
                break
            nxt = row["next_attempt_at"]
            delays.append((parse_iso(nxt) - now).total_seconds())
            now = parse_iso(nxt)
        assert delays == [60, 300, 1800, 7200, 7200]
        assert state == "FATAL" and load_pub(conn, pubs["fb"])["attempts"] == 6


@pytest.mark.parametrize("mode", ["crash", "timeout"])
def test_fb_crash_after_every_call_yields_exactly_one_reel(tmp_path, mode):
    def run(d, crash_at):
        with respx.mock(assert_all_called=False) as router:
            fake = FakeMeta(router)
            fake.crash_at, fake.crash_mode = crash_at, mode
            conn, rev, pubs = make_db(d, ("fb",))
            state, _ = drive(fb_factory(httpx.Client()), conn, pubs["fb"], rev, SLOT, T0, {"SCHEDULED"}, fake=fake)
            return fake, conn, pubs["fb"], state

    (tmp_path / "clean").mkdir()
    clean, *_ = run(tmp_path / "clean", None)
    n = len(clean.calls)
    assert n >= 5
    for i in range(1, n + 1):
        d = tmp_path / f"{mode}{i}"
        d.mkdir()
        fake, conn, pub_id, state = run(d, i)
        assert fake.crashed and state == "SCHEDULED"
        assert fake.fb_posts == 1 and fake.fb_finish_calls == 1, (mode, i, fake.calls)
        assert load_pub(conn, pub_id)["remote_id"] in fake.fb_videos


# ── Instagram ─────────────────────────────────────────────────────────────────


def test_ig_waits_until_20h_before_slot(env):
    fake, conn, rev, pubs, http = env
    early = SLOT.publish_at - timedelta(hours=21)
    assert ig_factory(http)().ensure(conn, load_pub(conn, pubs["ig"]), rev, now=early, slot=SLOT) == "PENDING"
    assert not fake.containers
    assert load_pub(conn, pubs["ig"])["next_attempt_at"] == (SLOT.publish_at - timedelta(hours=20)).isoformat()


def test_ig_full_flow(env):
    fake, conn, rev, pubs, http = env
    pub = ig_factory(http)()
    assert pub.ensure(conn, load_pub(conn, pubs["ig"]), rev, now=T0, slot=SLOT) == "PUBLISH_DUE"
    p = fake.container_params[0]
    assert p["media_type"] == "REELS" and p["upload_type"] == "resumable" and p["is_ai_generated"] == "true"
    assert p["share_to_feed"] == "true" and "AI आवाज" in p["caption"]
    row = load_pub(conn, pubs["ig"])
    assert row["container_id"] == "C1" and row["container_created_at"] == T0.isoformat()
    # Not due yet: no API traffic.
    n = len(fake.calls)
    assert pub.ensure(conn, row, rev, now=T0 + timedelta(hours=1), slot=SLOT) == "PUBLISH_DUE"
    assert len(fake.calls) == n
    fake.now = SLOT.publish_at
    assert pub.ensure(conn, row, rev, now=SLOT.publish_at, slot=SLOT) == "VERIFIED"
    row = load_pub(conn, pubs["ig"])
    assert row["remote_id"] == "M1" and row["permalink"].endswith("/M1/")
    assert fake.ig_publish_calls == 1


def test_ig_polls_in_progress_once_a_minute(tmp_path):
    with respx.mock(assert_all_called=False) as router:
        fake = FakeMeta(router, ig_processing_polls=2)
        conn, rev, pubs = make_db(tmp_path, ("ig",))
        pub = ig_factory(httpx.Client())()
        assert pub.ensure(conn, load_pub(conn, pubs["ig"]), rev, now=T0, slot=SLOT) == "UPLOADING"
        assert load_pub(conn, pubs["ig"])["next_attempt_at"] == (T0 + timedelta(minutes=1)).isoformat()
        assert pub.ensure(conn, load_pub(conn, pubs["ig"]), rev, now=T0 + timedelta(seconds=30), slot=SLOT) == "UPLOADING"
        assert fake.calls.count("ig_status") == 1
        state, _ = drive(lambda: pub, conn, pubs["ig"], rev, SLOT, T0 + timedelta(minutes=1), {"PUBLISH_DUE"})
        assert state == "PUBLISH_DUE" and fake.calls.count("ig_rupload") == 1


def test_ig_error_container_is_recreated_then_fatal(tmp_path):
    with respx.mock(assert_all_called=False) as router:
        fake = FakeMeta(router)
        fake.ig_container_error = 1
        conn, rev, pubs = make_db(tmp_path, ("ig",))
        assert ig_factory(httpx.Client())().ensure(conn, load_pub(conn, pubs["ig"]), rev, now=T0, slot=SLOT) == "PUBLISH_DUE"
        assert len(fake.containers) == 2 and load_pub(conn, pubs["ig"])["container_id"] == "C2"

    with respx.mock(assert_all_called=False) as router:
        fake = FakeMeta(router)
        fake.ig_container_error = 5
        (tmp_path / "b").mkdir()
        conn, rev, pubs = make_db(tmp_path / "b", ("ig",))
        assert ig_factory(httpx.Client())().ensure(conn, load_pub(conn, pubs["ig"]), rev, now=T0, slot=SLOT) == "FATAL"
        assert len(fake.containers) == 3


def test_ig_publishing_limit_defers_without_burning_attempts(env):
    fake, conn, rev, pubs, http = env
    fake.quota_usage = 50
    state = ig_factory(http)().ensure(conn, load_pub(conn, pubs["ig"]), rev, now=SLOT.publish_at, slot=SLOT)
    assert state == "RETRY" and fake.ig_publish_calls == 0
    row = load_pub(conn, pubs["ig"])
    assert row["attempts"] == 0 and row["next_attempt_at"] == (SLOT.publish_at + timedelta(hours=1)).isoformat()


def test_ig_after_cutoff_expires(env):
    fake, conn, rev, pubs, http = env
    pub = ig_factory(http)()
    assert pub.ensure(conn, load_pub(conn, pubs["ig"]), rev, now=T0, slot=SLOT) == "PUBLISH_DUE"
    late = SLOT.late_until + timedelta(minutes=1)
    assert pub.ensure(conn, load_pub(conn, pubs["ig"]), rev, now=late, slot=SLOT) == "EXPIRED"
    assert fake.ig_publish_calls == 0


def test_ig_never_publishes_in_quiet_hours(env):
    fake, conn, rev, pubs, http = env
    # An evening-style slot whose cut-off reaches into quiet hours (22:30 IST = 17:00 UTC).
    slot = replace(SLOT, publish_at=T0.replace(hour=16, minute=30), late_until=T0.replace(hour=18))
    now = T0.replace(hour=17, minute=5)
    assert ig_factory(http)().ensure(conn, load_pub(conn, pubs["ig"]), rev, now=now, slot=slot) == "PUBLISH_DUE"
    assert fake.ig_publish_calls == 0


def test_ig_recovers_published_container_without_republishing(env):
    fake, conn, rev, pubs, http = env
    pub = ig_factory(http)()
    pub.ensure(conn, load_pub(conn, pubs["ig"]), rev, now=T0, slot=SLOT)
    # Somebody (a crashed run) published the container but the result was never recorded.
    fake.now = SLOT.publish_at
    fake.crash_at, fake.crash_mode = len(fake.calls) + 3, "timeout"   # status, limit, publish -> response lost
    assert pub.ensure(conn, load_pub(conn, pubs["ig"]), rev, now=SLOT.publish_at, slot=SLOT) == "RETRY"
    assert load_pub(conn, pubs["ig"])["remote_id"] is None
    state = pub.ensure(conn, load_pub(conn, pubs["ig"]), rev, now=SLOT.publish_at + timedelta(minutes=2), slot=SLOT)
    assert state == "VERIFIED"
    assert fake.ig_publish_calls == 1 and "ig_list" in fake.calls
    assert load_pub(conn, pubs["ig"])["remote_id"] == "M1"


@pytest.mark.parametrize("mode", ["crash", "timeout"])
def test_ig_crash_after_every_call_yields_exactly_one_post(tmp_path, mode):
    def run(d, crash_at):
        with respx.mock(assert_all_called=False) as router:
            fake = FakeMeta(router, ig_processing_polls=1)
            fake.crash_at, fake.crash_mode = crash_at, mode
            conn, rev, pubs = make_db(d, ("ig",))
            state, _ = drive(ig_factory(httpx.Client()), conn, pubs["ig"], rev, SLOT, T0, {"VERIFIED"}, fake=fake)
            return fake, conn, pubs["ig"], state

    (tmp_path / "clean").mkdir()
    clean, *_ = run(tmp_path / "clean", None)
    n = len(clean.calls)
    assert n >= 8
    for i in range(1, n + 1):
        d = tmp_path / f"{mode}{i}"
        d.mkdir()
        fake, conn, pub_id, state = run(d, i)
        assert fake.crashed and state == "VERIFIED"
        assert len(fake.media) == 1 and fake.ig_publish_calls == 1, (mode, i, fake.calls)
        assert load_pub(conn, pub_id)["remote_id"] == "M1"


# ── Review fixes ──────────────────────────────────────────────────────────────


def test_meta_token_travels_in_header_not_url(env):
    fake, conn, rev, pubs, http = env
    assert fb_factory(http)().ensure(conn, load_pub(conn, pubs["fb"]), rev, now=T0, slot=SLOT) == "SCHEDULED"
    assert fake.urls and not any("access_token=" in u or "PAGE" in u or "SYS" in u for u in fake.urls)


def test_malformed_response_is_a_counted_retry(tmp_path):
    with respx.mock() as router:
        router.get("https://graph.facebook.com/v26.0/me/accounts").mock(return_value=httpx.Response(
            200, json={"data": [{"id": "P1", "access_token": "PAGE"}]}))
        router.post("https://graph.facebook.com/v26.0/P1/video_reels").mock(return_value=httpx.Response(
            200, json={"unexpected": True}))           # no video_id -> KeyError inside the publisher
        conn, rev, pubs = make_db(tmp_path, ("fb",))
        state = fb_factory(httpx.Client())().ensure(conn, load_pub(conn, pubs["fb"]), rev, now=T0, slot=SLOT)
        row = load_pub(conn, pubs["fb"])
        assert state == "RETRY" and row["attempts"] == 1 and "KeyError" in row["last_error"]
        assert row["next_attempt_at"] == (T0 + timedelta(minutes=1)).isoformat()


def test_fb_transient_error_after_scheduling_keeps_state(env):
    fake, conn, rev, pubs, http = env
    assert fb_factory(http)().ensure(conn, load_pub(conn, pubs["fb"]), rev, now=T0, slot=SLOT) == "SCHEDULED"
    later = SLOT.publish_at + timedelta(minutes=6)
    fake.fail_paths = {"/me/accounts"}   # a fresh process after the slot: /me/accounts is failing
    assert fb_factory(http)().ensure(conn, load_pub(conn, pubs["fb"]), rev, now=later, slot=SLOT) == "SCHEDULED"
    fake.fail_paths = set()
    row = load_pub(conn, pubs["fb"])
    assert row["state"] == "SCHEDULED" and row["next_attempt_at"] == (later + timedelta(minutes=1)).isoformat()
    fake.fb_videos["FV1"]["finish"] = {**fake.fb_videos["FV1"]["finish"], "video_state": "PUBLISHED"}
    assert fb_factory(http)().ensure(conn, load_pub(conn, pubs["fb"]), rev, now=later + timedelta(minutes=2),
                                     slot=SLOT) == "VERIFIED"
    assert fake.fb_finish_calls == 1


def test_fb_never_publishes_early_when_slot_is_beyond_29_days(env):
    fake, conn, rev, pubs, http = env
    far = replace(SLOT, publish_at=T0 + timedelta(days=30), late_until=T0 + timedelta(days=30, hours=3))
    pub = fb_factory(http)()
    assert pub.ensure(conn, load_pub(conn, pubs["fb"]), rev, now=T0, slot=far) == "UPLOADING"
    assert fake.fb_finish_calls == 0
    wake = far.publish_at - timedelta(days=29)
    assert load_pub(conn, pubs["fb"])["next_attempt_at"] == wake.isoformat()
    assert pub.ensure(conn, load_pub(conn, pubs["fb"]), rev, now=wake, slot=far) == "SCHEDULED"
    assert fake.fb_finish_calls == 1 and fake.fb_finish_params[0]["video_state"] == "SCHEDULED"
    assert fake.calls.count("fb_rupload") == 1


def test_fb_unverifiable_reel_gives_up_after_24h(env):
    fake, conn, rev, pubs, http = env
    pub = fb_factory(http)()
    assert pub.ensure(conn, load_pub(conn, pubs["fb"]), rev, now=T0, slot=SLOT) == "SCHEDULED"
    # Publishing phase never reports complete (status semantics differ from our guess).
    assert pub.ensure(conn, load_pub(conn, pubs["fb"]), rev, now=SLOT.publish_at + timedelta(minutes=6),
                      slot=SLOT) == "SCHEDULED"
    late = SLOT.publish_at + timedelta(hours=24, minutes=1)
    assert pub.ensure(conn, load_pub(conn, pubs["fb"]), rev, now=late, slot=SLOT) == "FATAL"
    assert any("FV1" in e["message"] for e in events(conn, "alert")) and fake.fb_finish_calls == 1


def test_ig_publish_refused_because_already_published_recovers(env):
    fake, conn, rev, pubs, http = env
    pub = ig_factory(http)()
    assert pub.ensure(conn, load_pub(conn, pubs["ig"]), rev, now=T0, slot=SLOT) == "PUBLISH_DUE"
    fake.now = SLOT.publish_at
    fake.crash_at, fake.crash_mode = len(fake.calls) + 3, "timeout"   # status, limit, publish -> response lost
    assert pub.ensure(conn, load_pub(conn, pubs["ig"]), rev, now=SLOT.publish_at, slot=SLOT) == "RETRY"
    fake.ig_status_lag = 1   # status_code has not caught up: still FINISHED on the next poll
    state = pub.ensure(conn, load_pub(conn, pubs["ig"]), rev, now=SLOT.publish_at + timedelta(minutes=2), slot=SLOT)
    assert state == "VERIFIED" and load_pub(conn, pubs["ig"])["remote_id"] == "M1"
    assert len(fake.media) == 1 and fake.ig_publish_calls == 2   # the second was refused by Meta


def test_ig_permalink_failing_for_24h_is_fatal(env):
    fake, conn, rev, pubs, http = env
    # A post recorded as PUBLISHED (media_publish returned MX) whose read-back keeps failing.
    record_result(conn, pubs["ig"], state="PUBLISHED", remote_id="MX", published_at=SLOT.publish_at)
    fake.fail_paths = {"/MX"}
    soon = SLOT.publish_at + timedelta(minutes=1)
    assert ig_factory(http)().ensure(conn, load_pub(conn, pubs["ig"]), rev, now=soon, slot=SLOT) == "PUBLISHED"
    late = SLOT.publish_at + timedelta(hours=24, minutes=1)
    assert ig_factory(http)().ensure(conn, load_pub(conn, pubs["ig"]), rev, now=late, slot=SLOT) == "FATAL"
    assert any("MX" in e["message"] for e in events(conn, "alert")) and fake.ig_publish_calls == 0
