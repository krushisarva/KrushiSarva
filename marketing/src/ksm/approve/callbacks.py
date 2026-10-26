"""Turning Telegram updates into approval Decisions.

Rules this module enforces:
- every update id is processed once (tg_updates insert-or-ignore, in the same
  transaction as any DB effect of the update);
- only the paired owner can act; strangers are ignored (their taps are still answered
  with an empty text so their client stops spinning);
- a tap counts only if its approval exists, is still pending, has no recorded
  decision yet, and its nonce matches — otherwise the founder sees 'हे कार्ड जुने आहे';
- every callback query is answered (process_update does that).

This module writes only approvals (platforms_json / decision_json / decided_at),
tg_updates and kv. Final decisions are persisted in approvals.decision_json before
they are returned, so if the process dies before the state machine applies them,
pending_decisions() hands them over again; the state machine owns approval status
and all video/publication state.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import re
import secrets
import sqlite3
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta

from ..db import iso, kv_get, kv_set, log_event, parse_iso, tx, utcnow
from ..models import ApprovalStatus, Decision
from .cards import ALL_PLATFORMS, EDIT_FIELDS, PLATFORM_LABEL, REDO_REASONS, edit_menu, keyboard, redo_menu
from .telegram import TelegramClient, TelegramError

log = logging.getLogger(__name__)

OWNER_KEY = "tg_owner_id"
CHAT_KEY = "tg_chat_id"
PAIR_KEY = "tg_pair"
OFFSET_KEY = "tg_offset"
OFFSET_AT_KEY = "tg_offset_at"
EDIT_KEY = "tg_pending_edit"
PAIR_TTL = timedelta(minutes=15)
EDIT_TTL = timedelta(minutes=30)
# Telegram picks the next update_id at random after a week without updates, so an old
# persisted offset could be higher than new ids and silently confirm (drop) them.
OFFSET_MAX_AGE = timedelta(days=6)

STALE = "हे कार्ड जुने आहे"
ALREADY = "हा निर्णय आधीच नोंदवला आहे"
NO_PLATFORM = "किमान एक प्लॅटफॉर्म निवडा"
EDIT_LIMITS = {"yt_title": 100, "ig_caption": 2200, "fb_caption": 2200}

_PAIR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"   # no 0/O/1/I: typed by hand
_CB = re.compile(r"^(a|n|s|r|e|b|p(?:yt|ig|fb)|r[lmvo]|e[tif]):(\d{1,12}):([A-Za-z0-9_-]{1,16})$")
_START = re.compile(r"^/start(?:@\w+)?\s+(\S+)\s*$")
_LINK = re.compile(r"https?://|www\.", re.I)
_REMOVE_KB = {"inline_keyboard": []}


@dataclass
class UpdateResult:
    """What handle_update decided plus the Telegram side effects the caller should perform."""

    decision: Decision | None = None
    callback_id: str | None = None
    answer: str = ""                    # answerCallbackQuery text
    chat_id: int | None = None
    message_id: int | None = None       # message whose inline keyboard should be replaced
    edit_markup: dict | None = None
    reply_text: str | None = None       # plain-text message to send to chat_id
    reply_markup: dict | None = None
    paired: bool = False


# ── pairing ───────────────────────────────────────────────────────────────────


def _hash(code: str) -> str:
    return hashlib.sha256(code.strip().upper().encode()).hexdigest()


def new_pair_code(conn: sqlite3.Connection, now: datetime | None = None) -> str:
    """Issue a single-use pairing code valid for 15 min; replaces any earlier code.

    Only its hash is stored. The founder sends '/start <code>' to the bot.
    """
    now = now or utcnow()
    code = "".join(secrets.choice(_PAIR_ALPHABET) for _ in range(10))
    kv_set(conn, PAIR_KEY, json.dumps({"sha256": _hash(code), "expires_at": iso(now + PAIR_TTL)}))
    return code


def owner(conn: sqlite3.Connection) -> tuple[int | None, int | None]:
    """(owner user id, owner chat id) or (None, None) before pairing."""
    uid, cid = kv_get(conn, OWNER_KEY), kv_get(conn, CHAT_KEY)
    return (int(uid) if uid else None, int(cid) if cid else None)


def _try_pair(conn: sqlite3.Connection, msg: dict, code: str, now: datetime) -> UpdateResult:
    chat = msg.get("chat") or {}
    res = UpdateResult(chat_id=chat.get("id"))
    user_id = (msg.get("from") or {}).get("id")
    raw = kv_get(conn, PAIR_KEY)
    rec = json.loads(raw) if raw else None
    expires = parse_iso(rec.get("expires_at")) if rec else None
    if (chat.get("type") != "private" or not isinstance(user_id, int) or rec is None
            or expires is None or now >= expires or not hmac.compare_digest(rec.get("sha256", ""), _hash(code))):
        res.reply_text = "❌ कोड चुकीचा किंवा जुना आहे. `ksm pair-telegram` पुन्हा चालवा."
        return res
    # Single use: the first matching /start consumes the code inside this transaction.
    conn.execute("DELETE FROM kv WHERE key = ?", (PAIR_KEY,))
    kv_set(conn, OWNER_KEY, str(user_id))
    kv_set(conn, CHAT_KEY, str(chat["id"]))
    log_event(conn, "telegram_paired", user_id=user_id)
    res.paired = True
    res.reply_text = "✅ KrushiSarva मार्केटिंग बॉट जोडला. मंजुरीची कार्डे इथे येतील."
    return res


# ── callbacks ─────────────────────────────────────────────────────────────────


def parse_callback(data: str) -> tuple[str, int, str] | None:
    """'act:id:nonce' -> (act, id, nonce); None for anything malformed."""
    m = _CB.match(data or "")
    if not m:
        return None
    return m.group(1), int(m.group(2)), m.group(3)


def _live_approval(conn: sqlite3.Connection, approval_id: int, nonce: str) -> sqlite3.Row | None:
    """The approval if a tap on it still counts: pending, right nonce, and still bound to
    the revision's current content hash (an approval covers that exact video + metadata)."""
    row = conn.execute(
        "SELECT a.*, COALESCE(r.content_hash, '') AS rev_hash FROM approvals a "
        "JOIN revisions r ON r.id = a.revision_id WHERE a.id = ?", (approval_id,)).fetchone()
    if row is None or row["status"] != ApprovalStatus.PENDING.value:
        return None
    if not hmac.compare_digest(str(row["nonce"]), nonce):
        return None
    if not row["content_hash"] or row["rev_hash"] != row["content_hash"]:
        return None
    return row


def _record(conn: sqlite3.Connection, d: Decision, now: datetime) -> bool:
    cur = conn.execute(
        "UPDATE approvals SET decision_json = ?, decided_at = ? "
        "WHERE id = ? AND status = ? AND decision_json IS NULL",
        (json.dumps(asdict(d), ensure_ascii=False), iso(now), d.approval_id, ApprovalStatus.PENDING.value),
    )
    if cur.rowcount == 1:
        log_event(conn, "approval_decision", None, approval_id=d.approval_id, action=d.action,
                  platforms=list(d.platforms), reason=d.reason, edit_field=d.edit_field)
        return True
    return False


def _on_callback(conn: sqlite3.Connection, cq: dict, owner_id: int | None, now: datetime) -> UpdateResult:
    msg = cq.get("message") or {}
    res = UpdateResult(callback_id=cq.get("id"), chat_id=(msg.get("chat") or {}).get("id"),
                       message_id=msg.get("message_id"))
    if not owner_id or (cq.get("from") or {}).get("id") != owner_id:
        return res
    parsed = parse_callback(cq.get("data") or "")
    row = _live_approval(conn, parsed[1], parsed[2]) if parsed else None
    if parsed is None or row is None:
        res.answer, res.edit_markup = STALE, _REMOVE_KB
        return res
    act, aid, nonce = parsed
    if row["decision_json"]:
        res.answer, res.edit_markup = ALREADY, _REMOVE_KB
        return res
    platforms = tuple(p for p in json.loads(row["platforms_json"] or "[]") if p in ALL_PLATFORMS)

    def final(d: Decision, answer: str) -> UpdateResult:
        if _record(conn, d, now):
            res.decision, res.answer, res.edit_markup = d, answer, _REMOVE_KB
        else:
            res.answer = ALREADY
        return res

    if act in ("a", "n"):
        if not platforms:
            res.answer = NO_PLATFORM
            return res
        if act == "a":
            return final(Decision(aid, "approve", platforms), "✅ मंजूर — नोंद झाली")
        return final(Decision(aid, "post_now", platforms), "⚡ आत्ताच प्रकाशित करत आहे")
    if act == "s":
        return final(Decision(aid, "skip", platforms), "⏭ वगळले")
    if act in REDO_REASONS:
        reason = REDO_REASONS[act]
        return final(Decision(aid, "redo", platforms, reason=reason), f"🔄 पुन्हा बनवत आहे ({reason})")
    if act == "r":
        res.answer, res.edit_markup = "कारण निवडा", redo_menu(aid, nonce)
        return res
    if act == "e":
        res.answer, res.edit_markup = "काय बदलायचे?", edit_menu(aid, nonce)
        return res
    if act == "b":
        res.edit_markup = keyboard(aid, nonce, list(platforms))
        return res
    if act in EDIT_FIELDS:
        field, label = EDIT_FIELDS[act]
        kv_set(conn, EDIT_KEY, json.dumps({"approval_id": aid, "nonce": nonce, "field": field,
                                           "expires_at": iso(now + EDIT_TTL)}))
        res.answer = f"नवीन {label} पाठवा"
        res.edit_markup = keyboard(aid, nonce, list(platforms))
        res.reply_text = f"✏️ नवीन {label} पाठवा (रद्द करण्यासाठी /cancel)"
        res.reply_markup = {"force_reply": True, "input_field_placeholder": label}
        return res
    # p<platform>: toggle, persisted on the approval so the later ✅ uses it.
    p = act[1:]
    chosen = set(platforms) ^ {p}
    new = tuple(x for x in ALL_PLATFORMS if x in chosen)
    conn.execute("UPDATE approvals SET platforms_json = ? WHERE id = ?", (json.dumps(list(new)), aid))
    res.decision = Decision(aid, "toggle_platform", new)
    res.answer = f"{PLATFORM_LABEL[p]} {'✓' if p in chosen else '✗'}"
    res.edit_markup = keyboard(aid, nonce, list(new))
    return res


# ── messages ──────────────────────────────────────────────────────────────────


def _on_message(conn: sqlite3.Connection, msg: dict, owner_id: int | None, now: datetime) -> UpdateResult:
    text = (msg.get("text") or "").strip()
    m = _START.match(text)
    if m:
        return _try_pair(conn, msg, m.group(1), now)
    if not owner_id or (msg.get("from") or {}).get("id") != owner_id:
        return UpdateResult()
    res = UpdateResult(chat_id=(msg.get("chat") or {}).get("id"))
    raw = kv_get(conn, EDIT_KEY)
    if not raw or not text:
        return res
    if text.split()[0] == "/cancel":
        conn.execute("DELETE FROM kv WHERE key = ?", (EDIT_KEY,))
        res.reply_text = "बदल रद्द केला."
        return res
    if text.startswith("/"):
        return res
    pending = json.loads(raw)
    expires = parse_iso(pending.get("expires_at"))
    row = _live_approval(conn, int(pending["approval_id"]), str(pending["nonce"]))
    if expires is None or now >= expires or row is None or row["decision_json"]:
        conn.execute("DELETE FROM kv WHERE key = ?", (EDIT_KEY,))
        res.reply_text = STALE
        return res
    field = pending["field"]
    limit = EDIT_LIMITS.get(field, 2200)
    if len(text) > limit:
        res.reply_text = f"❌ खूप लांब ({len(text)}/{limit}). पुन्हा पाठवा."
        return res
    if field == "yt_title" and ("<" in text or ">" in text):
        res.reply_text = "❌ YouTube शीर्षकात < किंवा > चालत नाही. पुन्हा पाठवा."
        return res
    if field == "fb_caption" and _LINK.search(text):
        res.reply_text = "❌ Facebook कॅप्शनमध्ये लिंक चालत नाही. पुन्हा पाठवा."
        return res
    platforms = tuple(p for p in json.loads(row["platforms_json"] or "[]") if p in ALL_PLATFORMS)
    d = Decision(int(row["id"]), "edit", platforms, edit_field=field, edit_value=text)
    conn.execute("DELETE FROM kv WHERE key = ?", (EDIT_KEY,))
    if _record(conn, d, now):
        res.decision = d
        res.reply_text = "✏️ बदल नोंदवला. नवीन कार्ड पुन्हा मंजुरीसाठी येईल."
    else:
        res.reply_text = ALREADY
    return res


# ── entry points ──────────────────────────────────────────────────────────────


def handle_update_full(conn: sqlite3.Connection, update: dict, *, owner_id: int | None,
                       now: datetime | None = None) -> UpdateResult:
    now = now or utcnow()
    uid = update.get("update_id")
    if not isinstance(uid, int):
        return UpdateResult()
    with tx(conn):
        if conn.execute("INSERT OR IGNORE INTO tg_updates(update_id) VALUES (?)", (uid,)).rowcount == 0:
            cq = update.get("callback_query") or {}
            return UpdateResult(callback_id=cq.get("id"))       # duplicate delivery: answer, do nothing
        if isinstance(update.get("callback_query"), dict):
            return _on_callback(conn, update["callback_query"], owner_id, now)
        if isinstance(update.get("message"), dict):
            return _on_message(conn, update["message"], owner_id, now)
    return UpdateResult()


def handle_update(conn: sqlite3.Connection, update: dict, *, owner_id: int,
                  now: datetime | None = None) -> Decision | None:
    """Contract entry point: DB-side handling only. The poller should prefer process_update,
    which also answers the callback and updates the keyboard."""
    return handle_update_full(conn, update, owner_id=owner_id, now=now).decision


def process_update(conn: sqlite3.Connection, tg: TelegramClient, update: dict, *, owner_id: int | None,
                   now: datetime | None = None) -> Decision | None:
    """handle_update plus its Telegram side effects. Telegram failures here never lose a
    decision: it is already committed (and recoverable via pending_decisions)."""
    res = handle_update_full(conn, update, owner_id=owner_id, now=now)
    # Each side effect is independent: answerCallbackQuery fails with 400 "query is too old"
    # for taps processed after downtime, and that must not suppress the keyboard edit or
    # the ForceReply prompt of the edit flow.
    if res.callback_id:
        _side_effect(tg.answer_callback, res.callback_id, res.answer)
    if res.edit_markup is not None and res.chat_id is not None and res.message_id is not None:
        _side_effect(tg.edit_reply_markup, res.chat_id, res.message_id, res.edit_markup)
    if res.reply_text and res.chat_id is not None:
        _side_effect(tg.send_message, res.chat_id, res.reply_text, res.reply_markup, parse_mode=None)
    return res.decision


def _side_effect(fn, *args, **kwargs) -> None:
    try:
        fn(*args, **kwargs)
    except TelegramError as e:
        log.warning("telegram side effect failed: %s", e)


def poll_once(conn: sqlite3.Connection, tg: TelegramClient, *, timeout: int = 50,
              now: datetime | None = None) -> list[Decision]:
    """One getUpdates long poll; returns the decisions it produced (toggles included)."""
    off = kv_get(conn, OFFSET_KEY)
    off_at = parse_iso(kv_get(conn, OFFSET_AT_KEY))
    clock = now or utcnow()
    if off and (off_at is None or clock - off_at > OFFSET_MAX_AGE):
        off = None   # no offset = from the earliest unconfirmed update; tg_updates dedupes re-deliveries
    out: list[Decision] = []
    for u in tg.get_updates(int(off) if off else None, timeout=timeout):
        owner_id, _ = owner(conn)            # re-read: a /start in this batch may have paired
        d = process_update(conn, tg, u, owner_id=owner_id, now=now)
        if d is not None:
            out.append(d)
        if isinstance(u.get("update_id"), int):
            with tx(conn):
                kv_set(conn, OFFSET_KEY, str(u["update_id"] + 1))
                kv_set(conn, OFFSET_AT_KEY, iso(now or utcnow()))
    return out


def pending_decisions(conn: sqlite3.Connection) -> list[Decision]:
    """Final decisions recorded on still-pending approvals: what the state machine has yet to apply."""
    rows = conn.execute(
        "SELECT decision_json FROM approvals WHERE status = ? AND decision_json IS NOT NULL ORDER BY decided_at, id",
        (ApprovalStatus.PENDING.value,),
    ).fetchall()
    out = []
    for r in rows:
        d = json.loads(r["decision_json"])
        d["platforms"] = tuple(d.get("platforms") or ())
        out.append(Decision(**d))
    return out


def prune_updates(conn: sqlite3.Connection, keep: int = 10_000) -> None:
    """tg_updates only needs to cover Telegram's 24 h redelivery window."""
    conn.execute("DELETE FROM tg_updates WHERE update_id < (SELECT MAX(update_id) FROM tg_updates) - ?", (keep,))
