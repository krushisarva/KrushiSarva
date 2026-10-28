import json
from pathlib import Path

import httpx
import pytest
import respx
import yaml

from ksm.approve.cards import YT_TERMS_LINE, card_texts, edit_menu, keyboard, redo_menu, send_card
from ksm.approve.telegram import TelegramClient, utf16_len
from ksm.config import _settings_from_dict
from ksm.db import open_db

SETTINGS_YAML = Path(__file__).resolve().parents[2] / "config" / "settings.yaml"
TOKEN = "1:TEST"
BASE = f"https://api.telegram.org/bot{TOKEN}"


def settings(**raw_extra):
    d = yaml.safe_load(SETTINGS_YAML.read_text(encoding="utf-8"))
    d.update(raw_extra)
    return _settings_from_dict(d)


def script(**over):
    s = {
        "hook": {"voice_mr": "सोयाबीनला आज लातूरमध्ये ४,८५० रुपये", "onscreen_mr": "सोयाबीन ₹4,850"},
        "segments": [{"voice_mr": "भाग", "onscreen_mr": "भाग", "visual": {"kind": "title"}}] * 3,
        "cta_mr": "फॉलो करा",
        "platform": {
            "yt": {"title": "सोयाबीन भाव <आज> | Soybean price", "description": "आजचे भाव & MSP", "tags": ["soybean"]},
            "ig": {"caption": "आजचे भाव", "hashtags": ["सोयाबीन", "#mandi"]},
            "fb": {"caption": "आजचे भाव FB", "hashtags": ["soybean"]},
        },
        "claims": [
            {"kind": "number", "text_mr": "लातूर मॉडल भाव", "value": "4850", "unit": "₹/क्विंटल",
             "data_ref": "commodities[0]"},
            {"kind": "fact", "text_mr": "MSP 2025-26", "value": "5328", "source_url": "https://pib.gov.in/x"},
        ],
        "chemicals_mentioned_en": [],
        "sources_onscreen_mr": "स्रोत: Agmarknet",
    }
    s.update(over)
    return s


def rows(*, meta=None, checks=None, desc=None, slot=True):
    sc = script()
    if desc is not None:
        sc["platform"]["yt"]["description"] = desc
    rev = {"id": 3, "rev_no": 1, "script_json": json.dumps(sc, ensure_ascii=False),
           "metadata_json": json.dumps(meta or {}), "checks_json": json.dumps(
               checks if checks is not None else {"deterministic": {"ok": True, "issues": []}}),
           "duration_s": 41.5, "content_hash": "h1", "preview_path": None}
    vid = {"id": 7, "series": "mandi", "data_date": "2026-10-15", "redo_count": 1,
           "fresh_until": "2026-10-16T04:30:00+00:00",
           "payload_json": json.dumps({"source": "Agmarknet / data.gov.in, Government of India"})}
    sl = {"id": "2026-10-16@fresh", "publish_at": "2026-10-16T01:30:00+00:00",
          "approve_by": "2026-10-16T01:15:00+00:00", "late_until": "2026-10-16T04:30:00+00:00"} if slot else None
    return rev, vid, sl


def test_caption_and_details_content():
    rev, vid, sl = rows(meta={"yt": {"title": "संपादित शीर्षक"}})
    cap, det = card_texts(rev, vid, sl, settings(accounts={"youtube": "@krushisarva"}), platforms=["yt"], cost_inr=11.5)
    assert "आजचा बाजारभाव" in cap and "सोयाबीन ₹4,850" in cap
    assert "16 ऑक्टो 2026, 07:00 IST" in cap
    assert "YT ✓ · IG ✗ · FB ✗" in cap and "तपासणी: ✓" in cap and "₹11.50" in cap
    assert utf16_len(cap) <= 1024
    assert "@krushisarva" in det and "&lt;Facebook Page&gt;" in det       # placeholder, escaped
    assert "संपादित शीर्षक" in det                                        # metadata edit overrides draft
    assert "private → सार्वजनिक at 16 ऑक्टो 2026, 07:00 IST" in det
    assert "आजचे भाव &amp; MSP" in det                                      # HTML-escaped
    assert "#सोयाबीन #mandi" in det
    assert "https://pib.gov.in/x" in det and "Agmarknet / data.gov.in, Government of India · 2026-10-15" in det
    assert "'AI आवाज' ✓" in det and "containsSyntheticMedia ✓" in det and "is_ai_generated ✓" in det
    assert "रसायन तपासणी</b>: ✓" in det
    assert "1/2" in det
    assert "मुदत</b>: 16 ऑक्टो 2026, 06:45 IST" in det
    assert det.rstrip().endswith(YT_TERMS_LINE)


def test_failed_checks_and_chemicals_shown():
    checks = {"deterministic": {"ok": False, "issues": [
        {"code": "chemical_mentioned", "message": "x", "blocking": True, "where": "segments[1]"}]}}
    rev, vid, sl = rows(checks=checks)
    cap, det = card_texts(rev, vid, sl, settings())
    assert "तपासणी: ✗ (chemical_mentioned)" in cap
    assert "✗ रसायन" in det


def test_no_checks_never_shows_a_tick():
    rev, vid, sl = rows(checks={})
    cap, det = card_texts(rev, vid, sl, settings())
    assert "तपासणी: —" in cap and "रसायन तपासणी</b>: —" in det


def test_unscheduled_evergreen():
    rev, vid, _ = rows(slot=False)
    cap, det = card_texts(rev, vid, None, settings())
    assert "अजून ठरलेला नाही" in cap
    assert "private (" in det


def test_details_fit_4096_with_huge_fields():
    rev, vid, sl = rows(desc="<b>" * 3000 + "क्षेत्र " * 2000)
    sc = json.loads(rev["script_json"])
    sc["platform"]["ig"]["caption"] = "द्राक्ष & " * 900
    sc["platform"]["fb"]["caption"] = "कृषी " * 900
    sc["claims"] = sc["claims"] * 40
    rev["script_json"] = json.dumps(sc, ensure_ascii=False)
    cap, det = card_texts(rev, vid, sl, settings())
    assert utf16_len(det) <= 4096
    assert "<b>" not in det.split("वर्णन: ")[1].split("\n")[0]     # user text stays escaped
    assert det.rstrip().endswith(YT_TERMS_LINE)


def test_keyboard_layout_and_callback_sizes():
    kb = keyboard(123456789012, "abc123", ["yt", "fb"])
    rows_ = kb["inline_keyboard"]
    assert [b["text"] for b in rows_[0]] == ["✅ मंजूर", "⚡ आत्ताच"]
    assert [b["text"] for b in rows_[1]] == ["🧩 YT ✓", "IG ✗", "FB ✓"]
    assert [b["text"] for b in rows_[2]] == ["✏️ बदल", "🔄 पुन्हा", "⏭ वगळा"]
    datas = [b["callback_data"] for r in rows_ for b in r]
    assert datas[:2] == ["a:123456789012:abc123", "n:123456789012:abc123"]
    assert "pig:123456789012:abc123" in datas and "s:123456789012:abc123" in datas
    for menu in (kb, edit_menu(1, "abc123"), redo_menu(1, "abc123")):
        for r in menu["inline_keyboard"]:
            for b in r:
                assert 1 <= len(b["callback_data"].encode()) <= 64


def test_keyboard_asserts_on_oversized_data():
    with pytest.raises(ValueError):          # a real check, not an assert stripped by python -O
        keyboard(1, "x" * 70, ["yt"])


@respx.mock
def test_send_card_supersedes_previous_pending(tmp_path):
    conn = open_db(tmp_path / "t.db")
    rev, vid, sl = rows()
    conn.execute("INSERT INTO videos(id, series, topic_key, state, created_at, updated_at) "
                 "VALUES (7,'mandi','soy','QA_PASSED','t','t')")
    conn.execute("INSERT INTO revisions(id, video_id, rev_no, script_json, content_hash, created_at) "
                 "VALUES (3,7,1,'{}','h1','t')")
    msg_id = iter(range(100, 200))
    respx.post(f"{BASE}/sendMessage").mock(side_effect=lambda r: httpx.Response(
        200, json={"ok": True, "result": {"message_id": next(msg_id)}}))
    edits = respx.post(f"{BASE}/editMessageReplyMarkup").mock(
        return_value=httpx.Response(200, json={"ok": True, "result": True}))
    tg = TelegramClient(TOKEN, httpx.Client(), sleep=lambda s: None)
    s = settings()
    a1 = send_card(conn, tg, chat_id=55, revision_row=rev, video_row=vid, slot_row=sl, settings=s)
    a2 = send_card(conn, tg, chat_id=55, revision_row=rev, video_row=vid, slot_row=sl, settings=s)
    st = dict(conn.execute("SELECT id, status FROM approvals").fetchall())
    assert st == {a1: "superseded", a2: "pending"}
    r2 = conn.execute("SELECT * FROM approvals WHERE id=?", (a2,)).fetchone()
    assert json.loads(r2["message_ids_json"]) == [102, 103]
    assert json.loads(r2["platforms_json"]) == ["yt"] and len(r2["nonce"]) == 6
    assert edits.call_count == 1                                   # old card's buttons removed
    conn.execute("UPDATE approvals SET status='approved' WHERE id=?", (a2,))
    with pytest.raises(ValueError):
        send_card(conn, tg, chat_id=55, revision_row=rev, video_row=vid, slot_row=sl, settings=s)


def _card_db(tmp_path):
    conn = open_db(tmp_path / "t.db")
    conn.execute("INSERT INTO videos(id, series, topic_key, state, created_at, updated_at) "
                 "VALUES (7,'mandi','soy','QA_PASSED','t','t')")
    conn.execute("INSERT INTO revisions(id, video_id, rev_no, script_json, content_hash, created_at) "
                 "VALUES (3,7,1,'{}','h1','t')")
    return conn


@respx.mock
def test_send_card_never_supersedes_an_unapplied_decision(tmp_path):
    """The ~20 h re-send must not drop a tap the state machine has not applied yet."""
    conn = _card_db(tmp_path)
    conn.execute("INSERT INTO approvals(id, revision_id, content_hash, nonce, status, decision_json) "
                 "VALUES (1,3,'h1','abc123','pending','{\"action\": \"approve\"}')")
    sm = respx.post(f"{BASE}/sendMessage").mock(return_value=httpx.Response(200, json={"ok": True, "result": {"message_id": 1}}))
    tg = TelegramClient(TOKEN, httpx.Client(), sleep=lambda s: None)
    rev, vid, sl = rows()
    with pytest.raises(ValueError, match="decision"):
        send_card(conn, tg, chat_id=55, revision_row=rev, video_row=vid, slot_row=sl, settings=settings())
    assert conn.execute("SELECT status FROM approvals WHERE id=1").fetchone()[0] == "pending"
    assert sm.call_count == 0


def test_send_card_requires_content_hash(tmp_path):
    conn = _card_db(tmp_path)
    rev, vid, sl = rows()
    rev["content_hash"] = None
    with pytest.raises(ValueError, match="content_hash"):
        send_card(conn, object(), chat_id=55, revision_row=rev, video_row=vid, slot_row=sl, settings=settings())
    assert conn.execute("SELECT COUNT(*) FROM approvals").fetchone()[0] == 0


@respx.mock
def test_send_card_persists_ids_of_a_half_sent_card(tmp_path):
    conn = _card_db(tmp_path)
    respx.post(f"{BASE}/sendMessage").mock(side_effect=[
        httpx.Response(200, json={"ok": True, "result": {"message_id": 100}}),
        httpx.Response(400, json={"ok": False, "error_code": 400, "description": "Bad Request: can't parse"}),
    ])
    tg = TelegramClient(TOKEN, httpx.Client(), sleep=lambda s: None)
    rev, vid, sl = rows()
    with pytest.raises(Exception):
        send_card(conn, tg, chat_id=55, revision_row=rev, video_row=vid, slot_row=sl, settings=settings())
    assert json.loads(conn.execute("SELECT message_ids_json FROM approvals").fetchone()[0]) == [100]
