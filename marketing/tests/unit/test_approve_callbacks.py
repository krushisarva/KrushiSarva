import json
from datetime import datetime, timedelta, timezone

import httpx
import pytest
import respx

from ksm.approve.callbacks import (
    STALE,
    handle_update,
    handle_update_full,
    new_pair_code,
    owner,
    parse_callback,
    pending_decisions,
    poll_once,
    process_update,
    prune_updates,
)
from ksm.approve.telegram import TelegramClient
from ksm.db import kv_get, open_db

OWNER = 1001
CHAT = 1001
NOW = datetime(2026, 10, 15, 16, 0, tzinfo=timezone.utc)
TOKEN = "9:TEST"
BASE = f"https://api.telegram.org/bot{TOKEN}"


@pytest.fixture
def conn(tmp_path):
    c = open_db(tmp_path / "t.db")
    c.execute("INSERT INTO videos(id, series, topic_key, state, created_at, updated_at) "
              "VALUES (7,'mandi','soy','AWAITING_APPROVAL','t','t')")
    c.execute("INSERT INTO revisions(id, video_id, rev_no, script_json, content_hash, created_at) "
              "VALUES (3,7,1,'{}','h','t')")
    c.execute("INSERT INTO approvals(id, revision_id, content_hash, nonce, status, platforms_json) "
              "VALUES (11,3,'h','abc123','pending','[\"yt\"]')")
    return c


_uid = iter(range(1, 10_000))


def cb(data, *, frm=OWNER, uid=None):
    return {"update_id": uid or next(_uid), "callback_query": {
        "id": f"cb{data}", "from": {"id": frm}, "data": data,
        "message": {"message_id": 50, "chat": {"id": CHAT, "type": "private"}}}}


def msg(text, *, frm=OWNER, uid=None, chat_type="private"):
    return {"update_id": uid or next(_uid), "message": {
        "message_id": 60, "from": {"id": frm}, "chat": {"id": frm, "type": chat_type}, "text": text}}


def test_parse_callback():
    assert parse_callback("a:11:abc123") == ("a", 11, "abc123")
    assert parse_callback("pyt:11:abc123") == ("pyt", 11, "abc123")
    assert parse_callback("rl:11:abc123") == ("rl", 11, "abc123")
    for bad in ("", "a:11", "z:11:abc123", "a:x:abc123", "a:11:abc:1", "pxx:1:abc123"):
        assert parse_callback(bad) is None


def test_approve_records_decision(conn):
    d = handle_update(conn, cb("a:11:abc123"), owner_id=OWNER, now=NOW)
    assert d is not None and d.action == "approve" and d.platforms == ("yt",) and d.approval_id == 11
    row = conn.execute("SELECT status, decision_json, decided_at FROM approvals WHERE id=11").fetchone()
    assert row["status"] == "pending"                       # status is the state machine's job
    assert json.loads(row["decision_json"])["action"] == "approve" and row["decided_at"]
    assert pending_decisions(conn) == [d]
    conn.execute("UPDATE approvals SET status='approved' WHERE id=11")
    assert pending_decisions(conn) == []


def test_second_final_tap_is_refused(conn):
    assert handle_update(conn, cb("a:11:abc123"), owner_id=OWNER, now=NOW)
    r = handle_update_full(conn, cb("s:11:abc123"), owner_id=OWNER, now=NOW)
    assert r.decision is None and r.answer and r.callback_id


def test_duplicate_update_id_is_skipped(conn):
    u = cb("a:11:abc123", uid=5000)
    assert handle_update(conn, u, owner_id=OWNER, now=NOW) is not None
    r = handle_update_full(conn, u, owner_id=OWNER, now=NOW)
    assert r.decision is None and r.callback_id == "cba:11:abc123"   # still answered


def test_non_owner_ignored(conn):
    r = handle_update_full(conn, cb("a:11:abc123", frm=666), owner_id=OWNER, now=NOW)
    assert r.decision is None and r.answer == "" and r.edit_markup is None
    assert handle_update(conn, msg("hello", frm=666), owner_id=OWNER, now=NOW) is None
    assert pending_decisions(conn) == []


@pytest.mark.parametrize("data,prep", [
    ("a:11:zzzzzz", None),                                             # wrong nonce
    ("a:99:abc123", None),                                             # unknown approval
    ("a:11:abc123", "UPDATE approvals SET status='superseded' WHERE id=11"),
    ("a:11:abc123", "UPDATE revisions SET content_hash='changed' WHERE id=3"),   # video/metadata changed
    ("garbage", None),
])
def test_stale_cards(conn, data, prep):
    if prep:
        conn.execute(prep)
    r = handle_update_full(conn, cb(data), owner_id=OWNER, now=NOW)
    assert r.decision is None and r.answer == STALE
    assert r.edit_markup == {"inline_keyboard": []}


def test_toggle_persists_platforms_then_approve_uses_them(conn):
    r = handle_update_full(conn, cb("pig:11:abc123"), owner_id=OWNER, now=NOW)
    assert r.decision.action == "toggle_platform" and r.decision.platforms == ("yt", "ig")
    assert [b["text"] for b in r.edit_markup["inline_keyboard"][1]] == ["🧩 YT ✓", "IG ✓", "FB ✗"]
    handle_update(conn, cb("pyt:11:abc123"), owner_id=OWNER, now=NOW)
    d = handle_update(conn, cb("n:11:abc123"), owner_id=OWNER, now=NOW)
    assert d.action == "post_now" and d.platforms == ("ig",)


def test_approve_with_no_platform_refused(conn):
    handle_update(conn, cb("pyt:11:abc123"), owner_id=OWNER, now=NOW)
    r = handle_update_full(conn, cb("a:11:abc123"), owner_id=OWNER, now=NOW)
    assert r.decision is None and "प्लॅटफॉर्म" in r.answer


def test_redo_menu_then_reason(conn):
    r = handle_update_full(conn, cb("r:11:abc123"), owner_id=OWNER, now=NOW)
    assert r.decision is None
    labels = [b["text"] for row in r.edit_markup["inline_keyboard"] for b in row]
    assert any("भाषा" in t for t in labels) and any("इतर" in t for t in labels)
    d = handle_update(conn, cb("rm:11:abc123"), owner_id=OWNER, now=NOW)
    assert d.action == "redo" and d.reason == "माहिती"


def test_edit_flow_via_force_reply(conn):
    r = handle_update_full(conn, cb("e:11:abc123"), owner_id=OWNER, now=NOW)
    assert r.decision is None and r.edit_markup["inline_keyboard"]
    r = handle_update_full(conn, cb("et:11:abc123"), owner_id=OWNER, now=NOW)
    assert r.reply_markup["force_reply"] is True and r.decision is None
    # stranger's text does not consume the pending edit
    assert handle_update(conn, msg("hack", frm=666), owner_id=OWNER, now=NOW) is None
    r = handle_update_full(conn, msg("x" * 101), owner_id=OWNER, now=NOW)
    assert r.decision is None and "101/100" in r.reply_text
    d = handle_update(conn, msg("सोयाबीन भाव आज"), owner_id=OWNER, now=NOW)
    assert d.action == "edit" and d.edit_field == "yt_title" and d.edit_value == "सोयाबीन भाव आज"
    assert kv_get(conn, "tg_pending_edit") is None


def test_edit_fb_link_rejected_and_cancel(conn):
    handle_update(conn, cb("ef:11:abc123"), owner_id=OWNER, now=NOW)
    r = handle_update_full(conn, msg("पहा https://x.y"), owner_id=OWNER, now=NOW)
    assert r.decision is None and "लिंक" in r.reply_text
    handle_update(conn, msg("/cancel"), owner_id=OWNER, now=NOW)
    assert kv_get(conn, "tg_pending_edit") is None
    assert handle_update(conn, msg("नवीन"), owner_id=OWNER, now=NOW) is None


def test_edit_expires_and_goes_stale(conn):
    handle_update(conn, cb("ei:11:abc123"), owner_id=OWNER, now=NOW)
    r = handle_update_full(conn, msg("उशीर"), owner_id=OWNER, now=NOW + timedelta(minutes=31))
    assert r.decision is None and r.reply_text == STALE
    handle_update(conn, cb("ei:11:abc123"), owner_id=OWNER, now=NOW)
    conn.execute("UPDATE approvals SET status='superseded' WHERE id=11")
    r = handle_update_full(conn, msg("नवीन"), owner_id=OWNER, now=NOW)
    assert r.decision is None and r.reply_text == STALE


def test_pairing_first_code_wins_and_expires(conn):
    code = new_pair_code(conn, now=NOW)
    assert len(code) == 10
    r = handle_update_full(conn, msg(f"/start {code}", frm=42), owner_id=None, now=NOW + timedelta(minutes=5))
    assert r.paired and owner(conn) == (42, 42)
    r = handle_update_full(conn, msg(f"/start {code}", frm=43), owner_id=42, now=NOW + timedelta(minutes=6))
    assert not r.paired and owner(conn) == (42, 42)           # single use

    code2 = new_pair_code(conn, now=NOW)
    r = handle_update_full(conn, msg(f"/start {code2}", frm=44), owner_id=42, now=NOW + timedelta(minutes=16))
    assert not r.paired and owner(conn) == (42, 42)           # expired
    code3 = new_pair_code(conn, now=NOW)
    r = handle_update_full(conn, msg(f"/start {code3}", frm=45, chat_type="group"), owner_id=42, now=NOW)
    assert not r.paired                                         # private chats only
    r = handle_update_full(conn, msg("/start WRONGCODE1", frm=45), owner_id=42, now=NOW)
    assert not r.paired


@respx.mock
def test_process_update_answers_and_edits(conn):
    ans = respx.post(f"{BASE}/answerCallbackQuery").mock(return_value=httpx.Response(200, json={"ok": True, "result": True}))
    ed = respx.post(f"{BASE}/editMessageReplyMarkup").mock(return_value=httpx.Response(200, json={"ok": True, "result": True}))
    tg = TelegramClient(TOKEN, httpx.Client(), sleep=lambda s: None)
    d = process_update(conn, tg, cb("a:11:abc123"), owner_id=OWNER, now=NOW)
    assert d.action == "approve"
    assert json.loads(ans.calls.last.request.content)["callback_query_id"] == "cba:11:abc123"
    assert json.loads(ed.calls.last.request.content) == {"chat_id": CHAT, "message_id": 50,
                                                          "reply_markup": {"inline_keyboard": []}}
    # stranger: still answered (empty) so their client stops spinning, nothing else
    process_update(conn, tg, cb("a:11:abc123", frm=7), owner_id=OWNER, now=NOW)
    assert ans.call_count == 2 and ed.call_count == 1


@respx.mock
def test_process_update_survives_telegram_failure(conn):
    respx.post(f"{BASE}/answerCallbackQuery").mock(return_value=httpx.Response(
        400, json={"ok": False, "error_code": 400, "description": "query is too old"}))
    ed = respx.post(f"{BASE}/editMessageReplyMarkup").mock(return_value=httpx.Response(200, json={"ok": True, "result": True}))
    tg = TelegramClient(TOKEN, httpx.Client(), sleep=lambda s: None)
    d = process_update(conn, tg, cb("s:11:abc123"), owner_id=OWNER, now=NOW)
    assert d.action == "skip" and pending_decisions(conn) == [d]
    assert ed.call_count == 1                 # a failed answer must not skip the keyboard edit


@respx.mock
def test_edit_prompt_sent_even_when_answer_is_too_old(conn):
    """Taps processed after downtime can't be answered; the ForceReply prompt must still go out."""
    respx.post(f"{BASE}/answerCallbackQuery").mock(return_value=httpx.Response(
        400, json={"ok": False, "error_code": 400, "description": "query is too old"}))
    respx.post(f"{BASE}/editMessageReplyMarkup").mock(return_value=httpx.Response(200, json={"ok": True, "result": True}))
    sm = respx.post(f"{BASE}/sendMessage").mock(return_value=httpx.Response(200, json={"ok": True, "result": {"message_id": 9}}))
    tg = TelegramClient(TOKEN, httpx.Client(), sleep=lambda s: None)
    process_update(conn, tg, cb("et:11:abc123"), owner_id=OWNER, now=NOW)
    assert sm.call_count == 1 and json.loads(sm.calls.last.request.content)["reply_markup"]["force_reply"] is True


def test_edit_yt_title_rejects_angle_brackets(conn):
    handle_update(conn, cb("et:11:abc123"), owner_id=OWNER, now=NOW)
    r = handle_update_full(conn, msg("भाव <आज>"), owner_id=OWNER, now=NOW)
    assert r.decision is None and "<" in r.reply_text
    assert kv_get(conn, "tg_pending_edit") is not None        # founder can resend


@respx.mock
def test_poll_once_pairs_then_accepts_and_advances_offset(conn):
    code = new_pair_code(conn, now=NOW)
    gu = respx.post(f"{BASE}/getUpdates").mock(side_effect=[
        httpx.Response(200, json={"ok": True, "result": [msg(f"/start {code}", uid=900), cb("a:11:abc123", uid=901)]}),
        httpx.Response(200, json={"ok": True, "result": []}),
    ])
    respx.post(f"{BASE}/sendMessage").mock(return_value=httpx.Response(200, json={"ok": True, "result": {"message_id": 1}}))
    respx.post(f"{BASE}/answerCallbackQuery").mock(return_value=httpx.Response(200, json={"ok": True, "result": True}))
    respx.post(f"{BASE}/editMessageReplyMarkup").mock(return_value=httpx.Response(200, json={"ok": True, "result": True}))
    tg = TelegramClient(TOKEN, httpx.Client(), sleep=lambda s: None)
    out = poll_once(conn, tg, timeout=1, now=NOW)
    assert [d.action for d in out] == ["approve"]
    assert kv_get(conn, "tg_offset") == "902"
    poll_once(conn, tg, timeout=1, now=NOW)
    assert json.loads(gu.calls.last.request.content)["offset"] == 902


@respx.mock
def test_poll_once_drops_offset_after_a_quiet_week(conn):
    """After 7 idle days Telegram restarts update ids at random; an old offset could drop them."""
    gu = respx.post(f"{BASE}/getUpdates").mock(side_effect=[
        httpx.Response(200, json={"ok": True, "result": [msg("hi", uid=700)]}),
        httpx.Response(200, json={"ok": True, "result": []}),
        httpx.Response(200, json={"ok": True, "result": []}),
    ])
    tg = TelegramClient(TOKEN, httpx.Client(), sleep=lambda s: None)
    poll_once(conn, tg, timeout=1, now=NOW)
    poll_once(conn, tg, timeout=1, now=NOW + timedelta(days=5))
    assert json.loads(gu.calls.last.request.content)["offset"] == 701
    poll_once(conn, tg, timeout=1, now=NOW + timedelta(days=7))
    assert "offset" not in json.loads(gu.calls.last.request.content)


def test_prune_updates(conn):
    for i in (1, 2, 50, 100):
        conn.execute("INSERT INTO tg_updates VALUES (?)", (i,))
    prune_updates(conn, keep=10)
    assert [r[0] for r in conn.execute("SELECT update_id FROM tg_updates ORDER BY 1")] == [100]
