import json
import logging

import httpx
import pytest
import respx

from ksm.approve.telegram import TelegramClient, TelegramError, truncate, utf16_len

TOKEN = "123456:SECRET-token-value"
BASE = f"https://api.telegram.org/bot{TOKEN}"


@pytest.fixture
def tg():
    sleeps: list[float] = []
    c = TelegramClient(TOKEN, httpx.Client(), sleep=sleeps.append)
    c.sleeps = sleeps  # type: ignore[attr-defined]
    return c


def ok(result):
    return httpx.Response(200, json={"ok": True, "result": result})


@respx.mock
def test_get_updates_sends_allowed_updates_and_offset(tg):
    route = respx.post(f"{BASE}/getUpdates").mock(return_value=ok([{"update_id": 5}]))
    assert tg.get_updates(7, timeout=30) == [{"update_id": 5}]
    body = json.loads(route.calls.last.request.content)
    assert body == {"offset": 7, "timeout": 30, "allowed_updates": ["message", "callback_query"]}


@respx.mock
def test_retry_after_on_429_is_respected(tg):
    route = respx.post(f"{BASE}/sendMessage").mock(side_effect=[
        httpx.Response(429, json={"ok": False, "error_code": 429, "description": "Too Many Requests",
                                  "parameters": {"retry_after": 7}}),
        ok({"message_id": 42}),
    ])
    assert tg.send_message(1, "नमस्कार") == 42
    assert route.call_count == 2
    assert tg.sleeps == [7.0]


@respx.mock
def test_5xx_backoff_then_gives_up(tg):
    route = respx.post(f"{BASE}/getMe").mock(return_value=httpx.Response(502, text="bad gateway"))
    with pytest.raises(TelegramError) as ei:
        tg.get_me()
    assert route.call_count == 4
    assert tg.sleeps == [1.0, 2.0, 4.0]
    assert TOKEN not in str(ei.value)


@respx.mock
def test_4xx_is_not_retried_and_token_never_leaks(tg, caplog):
    caplog.set_level(logging.DEBUG)
    respx.post(f"{BASE}/sendMessage").mock(return_value=httpx.Response(
        403, json={"ok": False, "error_code": 403, "description": "Forbidden: bot can't initiate conversation"}))
    with pytest.raises(TelegramError) as ei:
        tg.send_message(1, "x")
    assert ei.value.code == 403 and "initiate" in ei.value.description
    assert TOKEN not in str(ei.value) and TOKEN not in caplog.text and TOKEN not in repr(tg)


@respx.mock
def test_transport_error_retried_without_url_in_error(tg):
    respx.post(f"{BASE}/getMe").mock(side_effect=httpx.ConnectError(f"cannot reach {BASE}/getMe"))
    with pytest.raises(TelegramError) as ei:
        tg.get_me()
    assert TOKEN not in str(ei.value)
    assert ei.value.__cause__ is None or TOKEN not in str(ei.value.__cause__)
    assert len(tg.sleeps) == 3


@respx.mock
def test_send_video_multipart_reopens_file_on_retry(tg, tmp_path):
    f = tmp_path / "p.mp4"
    f.write_bytes(b"\x00" * 1000)
    route = respx.post(f"{BASE}/sendVideo").mock(side_effect=[
        httpx.Response(500, json={"ok": False, "description": "Internal"}),
        ok({"message_id": 9}),
    ])
    kb = {"inline_keyboard": [[{"text": "x", "callback_data": "a:1:abcdef"}]]}
    assert tg.send_video(55, f, "क" * 2000, kb) == 9
    req = route.calls.last.request
    body = req.content
    assert b"multipart/form-data" in req.headers["content-type"].encode()
    assert body.count(b"\x00" * 1000) == 1
    assert b'name="supports_streaming"' in body and b"true" in body
    assert json.dumps(kb).encode() in body
    # caption truncated to 1024 UTF-16 units
    cap = body.split(b'name="caption"\r\n\r\n')[1].split(b"\r\n--")[0].decode()
    assert utf16_len(cap) <= 1024


def test_send_video_rejects_over_50mb(tg, tmp_path):
    f = tmp_path / "big.mp4"
    with open(f, "wb") as fh:
        fh.truncate(50 * 1024 * 1024 + 1)
    with pytest.raises(ValueError):
        tg.send_video(1, f, "c", None)


@respx.mock
def test_edit_not_modified_is_success(tg):
    respx.post(f"{BASE}/editMessageReplyMarkup").mock(return_value=httpx.Response(
        400, json={"ok": False, "error_code": 400, "description": "Bad Request: message is not modified"}))
    tg.edit_reply_markup(1, 2, None)  # no raise


@respx.mock
def test_answer_callback_omits_empty_text(tg):
    route = respx.post(f"{BASE}/answerCallbackQuery").mock(return_value=ok(True))
    tg.answer_callback("cb1")
    assert json.loads(route.calls.last.request.content) == {"callback_query_id": "cb1"}


def test_html_message_over_limit_raises_plain_truncates(tg):
    with pytest.raises(ValueError):
        tg.send_message(1, "x" * 5000, parse_mode="HTML")


def test_truncate_keeps_graphemes_whole():
    s = "क्षेत्र" * 300
    t = truncate(s, 100)
    assert utf16_len(t) <= 100 and t.endswith("…")
    assert t[:-1].endswith("त्र") or t[:-1].endswith("क्षे")
    assert truncate("short", 10) == "short"
    assert utf16_len("🙂") == 2
