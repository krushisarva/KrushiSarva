from __future__ import annotations

from datetime import timedelta

import httpx
import pytest
import respx

from ksm.clock import next_youtube_quota_reset
from ksm.publish.common import load_pub
from ksm.publish.oauth import GoogleAuth
from ksm.publish.youtube import YouTubePublisher, build_metadata, fit_tags, marker_tag

from _publish_fixtures import T0, Crash, FakeYouTube, drive, events, make_db, make_settings, morning_slot

SETTINGS = make_settings()
SLOT = morning_slot(SETTINGS)


def make_pub(http: httpx.Client):
    def factory():
        return YouTubePublisher(http, GoogleAuth(http, lambda: ("cid", "csec", "refresh"), clock=lambda: T0), SETTINGS)
    return factory


@pytest.fixture
def env(tmp_path):
    with respx.mock(assert_all_called=False) as router:
        fake = FakeYouTube(router)
        conn, rev, pubs = make_db(tmp_path, ("yt",))
        yield fake, conn, rev, pubs["yt"], make_pub(httpx.Client())


# ── Metadata ──────────────────────────────────────────────────────────────────


def test_metadata_is_explicit_and_scheduled():
    meta = build_metadata({"title": "t", "description": "d", "tags": ["a"], "hashtags": ["#x"]}, "ksv-1-1",
                          publish_at=SLOT.publish_at)
    assert meta["status"] == {"privacyStatus": "private", "publishAt": "2026-10-17T01:30:00Z",
                              "selfDeclaredMadeForKids": False, "containsSyntheticMedia": True}
    sn = meta["snippet"]
    assert sn["categoryId"] == "27" and sn["defaultLanguage"] == "mr" and sn["defaultAudioLanguage"] == "mr"
    assert sn["tags"][0] == "ksv-1-1"
    assert "#x" in sn["description"] and "AI आवाज" in sn["description"]


def test_metadata_public_when_slot_is_near():
    meta = build_metadata({"title": "t"}, "ksv-1-1", publish_at=None, language=False)
    assert meta["status"]["privacyStatus"] == "public" and "publishAt" not in meta["status"]
    assert "defaultLanguage" not in meta["snippet"]


def test_empty_title_is_fatal():
    from ksm.publish.common import PublishError
    with pytest.raises(PublishError):
        build_metadata({"title": " "}, "m", publish_at=None)


def test_fit_tags_keeps_marker_and_budget():
    tags = fit_tags(["x" * 100] * 10, "ksv-9-2")
    assert tags[0] == "ksv-9-2"
    assert sum(len(t) for t in tags) + len(tags) - 1 <= 500
    assert fit_tags(["two words"], "m") == ["m", "two words"]


# ── Happy path ────────────────────────────────────────────────────────────────


def test_scheduled_upload(env):
    fake, conn, rev, pub_id, factory = env
    state = factory().ensure(conn, load_pub(conn, pub_id), rev, now=T0, slot=SLOT)
    assert state == "SCHEDULED"
    row = load_pub(conn, pub_id)
    assert row["remote_id"] == "V1" and row["upload_session_uri"]
    assert row["scheduled_for"] == "2026-10-17T01:30:00+00:00"
    assert row["permalink"] == "https://www.youtube.com/shorts/V1"
    body = fake.init_bodies[0]
    assert marker_tag(rev["video_id"], 1) in body["snippet"]["tags"]
    assert body["status"]["privacyStatus"] == "private"


def test_public_when_slot_less_than_15_min_away(env):
    fake, conn, rev, pub_id, factory = env
    now = SLOT.publish_at - timedelta(minutes=10)
    assert factory().ensure(conn, load_pub(conn, pub_id), rev, now=now, slot=SLOT) == "PUBLISHED"
    assert fake.init_bodies[0]["status"]["privacyStatus"] == "public"
    assert load_pub(conn, pub_id)["published_at"]


def test_verify_after_slot(env):
    fake, conn, rev, pub_id, factory = env
    pub = factory()
    assert pub.ensure(conn, load_pub(conn, pub_id), rev, now=T0, slot=SLOT) == "SCHEDULED"
    # Before the slot + grace: no call, next_attempt_at set.
    n = len(fake.calls)
    assert pub.ensure(conn, load_pub(conn, pub_id), rev, now=T0 + timedelta(minutes=1), slot=SLOT) == "SCHEDULED"
    assert len(fake.calls) == n
    fake.videos["V1"]["status"] = {"privacyStatus": "public", "uploadStatus": "processed"}
    later = SLOT.publish_at + timedelta(minutes=6)
    assert pub.ensure(conn, load_pub(conn, pub_id), rev, now=later, slot=SLOT) == "VERIFIED"


def test_language_rejected_retries_once_without(env):
    fake, conn, rev, pub_id, factory = env
    fake.reject_language = True
    assert factory().ensure(conn, load_pub(conn, pub_id), rev, now=T0, slot=SLOT) == "SCHEDULED"
    assert len(fake.init_bodies) == 2 and "defaultLanguage" not in fake.init_bodies[1]["snippet"]


def test_partial_upload_resumes_from_range(env):
    fake, conn, rev, pub_id, factory = env
    fake.partial_first_put = True
    assert factory().ensure(conn, load_pub(conn, pub_id), rev, now=T0, slot=SLOT) == "SCHEDULED"
    assert fake.calls.count("put") == 2 and len(fake.videos) == 1


# ── Errors ────────────────────────────────────────────────────────────────────


def test_quota_exceeded_waits_for_pacific_midnight(env):
    fake, conn, rev, pub_id, factory = env
    fake.quota_exceeded = True
    assert factory().ensure(conn, load_pub(conn, pub_id), rev, now=T0, slot=SLOT) == "RETRY"
    row = load_pub(conn, pub_id)
    assert row["next_attempt_at"] == next_youtube_quota_reset(T0).isoformat()
    assert row["attempts"] == 0


def test_401_refreshes_once(env):
    fake, conn, rev, pub_id, factory = env
    fake.unauthorized = 1
    assert factory().ensure(conn, load_pub(conn, pub_id), rev, now=T0, slot=SLOT) == "SCHEDULED"
    assert fake.tokens == 2


def test_401_twice_is_fatal_with_alert(env):
    fake, conn, rev, pub_id, factory = env
    fake.unauthorized = 2
    assert factory().ensure(conn, load_pub(conn, pub_id), rev, now=T0, slot=SLOT) == "FATAL"
    assert any("auth-youtube" in e["message"] for e in events(conn, "alert"))
    assert not fake.videos


def test_missing_master_is_fatal(env):
    fake, conn, rev, pub_id, factory = env
    rev = dict(rev) | {"master_path": "/nonexistent.mp4"}
    assert factory().ensure(conn, load_pub(conn, pub_id), rev, now=T0, slot=SLOT) == "FATAL"


# ── Recovery ──────────────────────────────────────────────────────────────────


def test_dead_session_after_completion_found_by_marker(env):
    fake, conn, rev, pub_id, factory = env
    fake.crash_at = 3  # token, init, put -> crash after the bytes landed
    with pytest.raises(Crash):
        factory().ensure(conn, load_pub(conn, pub_id), rev, now=T0, slot=SLOT)
    fake.sessions["S1"]["dead"] = True
    assert factory().ensure(conn, load_pub(conn, pub_id), rev, now=T0, slot=SLOT) == "SCHEDULED"
    assert len(fake.videos) == 1 and len(fake.sessions) == 1
    assert load_pub(conn, pub_id)["remote_id"] == "V1"


def test_dead_session_without_upload_starts_over(env):
    fake, conn, rev, pub_id, factory = env
    fake.crash_at = 2  # crash right after the session was created (no bytes sent)
    with pytest.raises(Crash):
        factory().ensure(conn, load_pub(conn, pub_id), rev, now=T0, slot=SLOT)
    assert load_pub(conn, pub_id)["upload_session_uri"] is None  # crashed before persisting
    assert factory().ensure(conn, load_pub(conn, pub_id), rev, now=T0, slot=SLOT) == "SCHEDULED"
    assert len(fake.videos) == 1


def test_expired_persisted_session_with_no_video_reuploads_once(env):
    fake, conn, rev, pub_id, factory = env
    fake.partial_first_put = True
    fake.crash_at = 3  # crash after a partial PUT
    with pytest.raises(Crash):
        factory().ensure(conn, load_pub(conn, pub_id), rev, now=T0, slot=SLOT)
    fake.sessions["S1"]["dead"] = True
    assert factory().ensure(conn, load_pub(conn, pub_id), rev, now=T0, slot=SLOT) == "SCHEDULED"
    assert len(fake.videos) == 1 and len(fake.sessions) == 2
    assert "channels" in fake.calls  # looked for the marker before uploading again


def _clean_call_count(tmp_path) -> int:
    with respx.mock(assert_all_called=False) as router:
        fake = FakeYouTube(router)
        (tmp_path / "clean").mkdir()
        conn, rev, pubs = make_db(tmp_path / "clean", ("yt",))
        drive(make_pub(httpx.Client()), conn, pubs["yt"], rev, SLOT, T0, {"SCHEDULED"})
        return len(fake.calls)


@pytest.mark.parametrize("mode", ["crash", "timeout"])
def test_crash_after_every_call_yields_exactly_one_video(tmp_path, mode):
    n = _clean_call_count(tmp_path)
    assert n >= 3
    for i in range(1, n + 1):
        d = tmp_path / f"{mode}{i}"
        d.mkdir()
        with respx.mock(assert_all_called=False) as router:
            fake = FakeYouTube(router)
            fake.crash_at, fake.crash_mode = i, mode
            conn, rev, pubs = make_db(d, ("yt",))
            state, _ = drive(make_pub(httpx.Client()), conn, pubs["yt"], rev, SLOT, T0, {"SCHEDULED"})
            assert fake.crashed, i
            assert state == "SCHEDULED"
            assert len(fake.videos) == 1, (mode, i, fake.calls)
            assert load_pub(conn, pubs["yt"])["remote_id"] == "V1"


# ── Review fixes ──────────────────────────────────────────────────────────────


def test_400_upload_limit_is_a_quota_wait_not_a_language_retry(env):
    fake, conn, rev, pub_id, factory = env
    fake.quota_exceeded, fake.quota_response = True, (400, "uploadLimitExceeded")
    assert factory().ensure(conn, load_pub(conn, pub_id), rev, now=T0, slot=SLOT) == "RETRY"
    assert fake.calls.count("init") == 1          # no second insert without the language fields
    row = load_pub(conn, pub_id)
    assert row["next_attempt_at"] == next_youtube_quota_reset(T0).isoformat() and row["attempts"] == 0


def test_never_public_video_gives_up_after_24h_with_alert(env):
    fake, conn, rev, pub_id, factory = env
    pub = factory()
    assert pub.ensure(conn, load_pub(conn, pub_id), rev, now=T0, slot=SLOT) == "SCHEDULED"
    fake.videos["V1"]["status"] = {"privacyStatus": "private", "uploadStatus": "processed"}  # locked private
    after = SLOT.publish_at + timedelta(minutes=6)
    assert pub.ensure(conn, load_pub(conn, pub_id), rev, now=after, slot=SLOT) == "UPLOADED"
    assert load_pub(conn, pub_id)["next_attempt_at"] == (after + timedelta(minutes=15)).isoformat()
    late = SLOT.publish_at + timedelta(hours=24, minutes=1)
    assert pub.ensure(conn, load_pub(conn, pub_id), rev, now=late, slot=SLOT) == "FATAL"
    assert load_pub(conn, pub_id)["remote_id"] == "V1"
    assert any("V1" in e["message"] for e in events(conn, "alert"))
    assert len(fake.videos) == 1
