"""Approval card: the two Telegram messages (preview video + details) and their buttons.

The card is the founder's only view of what will go out, so it shows the final
per-platform metadata (revision.metadata_json overrides the script's draft), every
claim with its source, the AI-disclosure flags and the safety-check results.

Rows may be sqlite3.Row or plain dicts. Inputs are read defensively because the
card must still render (with '—') if an upstream stage left a field empty.
"""
from __future__ import annotations

import html
import json
import secrets
import sqlite3
from collections.abc import Iterable, Mapping, Sequence
from datetime import datetime
from typing import Any

from ..clock import to_ist
from ..config import Settings
from ..db import iso, log_event, parse_iso, tx, utcnow
from ..models import ApprovalStatus
from .telegram import CAPTION_LIMIT, MESSAGE_LIMIT, TelegramClient, TelegramError, truncate, utf16_len

ALL_PLATFORMS: tuple[str, ...] = ("yt", "ig", "fb")
PLATFORM_LABEL = {"yt": "YT", "ig": "IG", "fb": "FB"}
YT_TERMS_LINE = "YouTube Terms: https://www.youtube.com/t/terms"
NONCE_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"

# Fallback Marathi series names when config/series.yaml (via settings.raw['series']) has none.
SERIES_NAME_MR = {
    "mandi": "आजचा बाजारभाव",
    "mandi_prices": "आजचा बाजारभाव",
    "rabi": "रब्बी पेरणी मार्गदर्शक",
    "rabi_sowing": "रब्बी पेरणी मार्गदर्शक",
    "yojana": "योजना अपडेट – खरं की खोटं?",
    "scheme": "योजना अपडेट – खरं की खोटं?",
    "pik_doctor": "पीक डॉक्टर",
    "crop_doctor": "पीक डॉक्टर",
}

_MONTHS_MR = ("जाने", "फेब्रु", "मार्च", "एप्रि", "मे", "जून", "जुलै", "ऑग", "सप्टें", "ऑक्टो", "नोव्हें", "डिसें")


# ── small helpers ─────────────────────────────────────────────────────────────


def _g(row: Any, key: str, default: Any = None) -> Any:
    if row is None:
        return default
    try:
        v = row[key]
    except (KeyError, IndexError, TypeError):
        return default
    return default if v is None else v


def _j(row: Any, key: str) -> dict:
    raw = _g(row, key)
    if isinstance(raw, dict):
        return raw
    if not raw:
        return {}
    try:
        v = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return v if isinstance(v, dict) else {}


def fmt_ist(dt: datetime | str | None) -> str:
    """'17 ऑक्टो 2026, 07:00 IST'."""
    if isinstance(dt, str):
        dt = parse_iso(dt)
    if dt is None:
        return "—"
    t = to_ist(dt)
    return f"{t.day} {_MONTHS_MR[t.month - 1]} {t.year}, {t:%H:%M} IST"


def _e(s: Any) -> str:
    return html.escape(str(s), quote=False)


def _mark(ok: bool | None) -> str:
    return "—" if ok is None else ("✓" if ok else "✗")


def new_nonce() -> str:
    return "".join(secrets.choice(NONCE_ALPHABET) for _ in range(6))


def series_name_mr(series: str, settings: Settings | None) -> str:
    raw = (settings.raw if settings else {}) or {}
    cfg = raw.get("series") if isinstance(raw.get("series"), Mapping) else {}
    entry = cfg.get(series) if cfg else None
    if isinstance(entry, Mapping) and entry.get("name_mr"):
        return str(entry["name_mr"])
    return SERIES_NAME_MR.get(series, series)


def platform_texts(revision_row: Any) -> dict[str, dict]:
    """Final per-platform metadata: script draft overlaid with revision.metadata_json (edits)."""
    script = _j(revision_row, "script_json")
    meta = _j(revision_row, "metadata_json")
    out: dict[str, dict] = {}
    for p in ALL_PLATFORMS:
        merged = dict((script.get("platform") or {}).get(p) or {})
        over = meta.get(p)
        if isinstance(over, Mapping):
            merged.update({k: v for k, v in over.items() if v is not None})
        out[p] = merged
    return out


def checks_summary(checks: Mapping) -> tuple[bool | None, list[str], bool | None]:
    """(all ok?, blocking issue codes, chemical screen ok?) from revision.checks_json.

    Accepts either a flat CheckReport-like dict {"ok", "issues": [...]} or sections
    {"deterministic": {...}, "factcheck": {...}, "qa": {...}, "chemicals": {...}}.
    None means "no evidence" — the card then shows '—', never a ✓.
    """
    sections: list[tuple[str, Mapping]] = []
    if "issues" in checks or "ok" in checks:
        sections.append(("", checks))
    sections += [(k, v) for k, v in checks.items() if isinstance(v, Mapping) and ("ok" in v or "issues" in v)]
    if not sections:
        return None, [], None
    ok = True
    codes: list[str] = []
    chem_ok: bool | None = None
    for name, sec in sections:
        issues = [i for i in (sec.get("issues") or []) if isinstance(i, Mapping)]
        blocking = [i for i in issues if i.get("blocking", True)]
        sec_ok = bool(sec.get("ok", not blocking)) and not blocking
        ok = ok and sec_ok
        codes += [str(i.get("code", "?")) for i in blocking]
        if "chem" in name:
            chem_ok = sec_ok if chem_ok is None else (chem_ok and sec_ok)
        chem_issues = [i for i in issues if "chemical" in str(i.get("code", ""))]
        if chem_issues:
            chem_ok = False
        elif chem_ok is None and name in ("", "deterministic"):
            chem_ok = True  # the deterministic suite includes check_chemicals
    return ok, list(dict.fromkeys(codes)), chem_ok


def _hashtags(tags: Iterable[str]) -> str:
    return " ".join(t if t.startswith("#") else f"#{t}" for t in (str(x).strip() for x in tags) if t)


def _accounts(settings: Settings | None) -> tuple[str, str, str]:
    acc = ((settings.raw if settings else {}) or {}).get("accounts") or {}
    if not isinstance(acc, Mapping):
        acc = {}

    def pick(*keys: str, placeholder: str) -> str:
        for k in keys:
            if acc.get(k):
                return str(acc[k])
        return placeholder

    return (
        pick("yt", "youtube", "youtube_channel", placeholder="<YouTube चॅनेल>"),
        pick("fb", "facebook", "facebook_page", placeholder="<Facebook Page>"),
        pick("ig", "instagram", "instagram_handle", placeholder="<Instagram @handle>"),
    )


# ── texts ─────────────────────────────────────────────────────────────────────


def card_texts(
    revision_row: Any,
    video_row: Any,
    slot_row: Any,
    settings: Settings,
    *,
    platforms: Sequence[str] | None = None,
    cost_inr: float | None = None,
) -> tuple[str, str]:
    """(video caption, plain text <= 1024; details, Telegram HTML <= 4096)."""
    script = _j(revision_row, "script_json")
    meta = _j(revision_row, "metadata_json")
    checks = _j(revision_row, "checks_json")
    payload = _j(video_row, "payload_json")
    texts = platform_texts(revision_row)

    if platforms is None:
        platforms = meta.get("platforms") or list(settings.platforms)
    selected = set(platforms)
    if cost_inr is None:
        cost_inr = meta.get("cost_inr", checks.get("cost_inr", _g(video_row, "cost_inr")))
    ok, codes, chem_ok = checks_summary(checks)
    if script.get("chemicals_mentioned_en"):
        chem_ok = False

    video_id = _g(video_row, "id", "?")
    rev_no = _g(revision_row, "rev_no", "?")
    series = series_name_mr(str(_g(video_row, "series", "")), settings)
    hook = (script.get("hook") or {})
    hook_text = hook.get("onscreen_mr") or hook.get("voice_mr") or "—"
    publish_at = _g(slot_row, "publish_at")
    slot_line = f"🕖 स्लॉट: {fmt_ist(publish_at)}" if publish_at else "🕖 स्लॉट: अजून ठरलेला नाही (राखीव व्हिडिओ)"
    plat_line = " · ".join(f"{PLATFORM_LABEL[p]} {_mark(p in selected)}" for p in ALL_PLATFORMS)
    qa_line = f"🧪 तपासणी: {_mark(ok)}" + (f" ({', '.join(codes[:4])})" if codes else "")
    cost_line = f"💰 खर्च: ₹{float(cost_inr):.2f}" if isinstance(cost_inr, (int, float)) else "💰 खर्च: ₹—"
    dur = _g(revision_row, "duration_s")
    caption_lines = [
        f"🎬 {series} · #{video_id} r{rev_no}",
        f"🪝 {hook_text}",
        slot_line,
        f"📲 प्लॅटफॉर्म: {plat_line}",
        qa_line,
        cost_line,
    ]
    if isinstance(dur, (int, float)):
        caption_lines.append(f"⏱ {dur:.1f} s")
    caption = truncate("\n".join(caption_lines), CAPTION_LIMIT)

    # Details: variable-length fields get a budget that shrinks until the HTML fits.
    yt_h, fb_h, ig_h = _accounts(settings)
    yt, ig, fb = texts["yt"], texts["ig"], texts["fb"]
    approve_by = _g(slot_row, "approve_by")
    fresh_until = _g(video_row, "fresh_until")
    expiry_candidates = [d for d in (parse_iso(approve_by) if approve_by else None,
                                     parse_iso(fresh_until) if fresh_until else None) if d]
    expiry = min(expiry_candidates) if expiry_candidates else None
    visibility = (f"private → सार्वजनिक at {fmt_ist(publish_at)}" if publish_at
                  else "private (स्लॉट ठरल्यावर वेळ लागेल)")
    yt_meta = meta.get("yt") if isinstance(meta.get("yt"), Mapping) else {}
    ig_meta = meta.get("ig") if isinstance(meta.get("ig"), Mapping) else {}
    synthetic = bool(yt_meta.get("containsSyntheticMedia", True))
    ig_ai = bool(ig_meta.get("is_ai_generated", True))
    ai_label = checks.get("ai_label") if isinstance(checks.get("ai_label"), Mapping) else None
    onscreen_ai = _mark(bool(ai_label.get("ok"))) if ai_label is not None else "✓"
    redo = int(_g(video_row, "redo_count", 0) or 0)
    claims = [c for c in (script.get("claims") or []) if isinstance(c, Mapping)]
    data_source = payload.get("source") or "डेटा payload"
    data_date = _g(video_row, "data_date") or payload.get("data_date") or "—"

    def build(desc_n: int, cap_n: int, claim_n: int) -> str:
        L: list[str] = [f"<b>📋 तपशील</b> · #{_e(video_id)} r{_e(rev_no)} · {_e(series)}", ""]
        L.append(f"<b>खाती</b>: YouTube {_e(yt_h)} · Facebook Page {_e(fb_h)} · Instagram {_e(ig_h)}")
        L.append("")
        L.append(f"<b>▶️ YouTube</b> {_mark('yt' in selected)}")
        L.append(f"शीर्षक: {_e(yt.get('title') or '—')}")
        L.append(f"वर्णन: {_e(truncate(str(yt.get('description') or '—'), desc_n))}")
        if yt.get("tags"):
            L.append(f"टॅग: {_e(truncate(', '.join(map(str, yt['tags'])), 300))}")
        L.append(f"दृश्यता: {_e(visibility)}")
        L.append("")
        for label, key, d in (("📸 Instagram", "ig", ig), ("📘 Facebook", "fb", fb)):
            L.append(f"<b>{label}</b> {_mark(key in selected)}")
            L.append(f"कॅप्शन: {_e(truncate(str(d.get('caption') or '—'), cap_n))}")
            if d.get("hashtags"):
                L.append(f"हॅशटॅग: {_e(_hashtags(d['hashtags']))}")
            L.append("")
        L.append("<b>📌 दावे व स्रोत</b>")
        if not claims:
            L.append("• —")
        for c in claims[:claim_n]:
            val = " ".join(str(x) for x in (c.get("value"), c.get("unit")) if x)
            if c.get("source_url"):
                src = str(c["source_url"])
            elif c.get("data_ref") or c.get("kind") == "number":
                src = f"{data_source} · {data_date}"
            else:
                src = "स्रोत नाही ⚠️"
            item = truncate(str(c.get("text_mr") or ""), 160)
            L.append(f"• {_e(item)}" + (f" — {_e(val)}" if val else "") + f" — {_e(src)}")
        if len(claims) > claim_n:
            L.append(f"• … आणखी {len(claims) - claim_n}")
        L.append("")
        L.append(f"<b>🤖 AI खुलासा</b>: व्हिडिओवर 'AI आवाज' {onscreen_ai} · "
                 f"YT containsSyntheticMedia {_mark(synthetic)} · IG is_ai_generated {_mark(ig_ai)}")
        L.append(f"<b>🧪 रसायन तपासणी</b>: " + {True: "✓ कोणतेही नाव/मात्रा नाही",
                                                False: "✗ रसायन/मात्रा आढळली",
                                                None: "— निकाल नाही"}[chem_ok])
        L.append(f"<b>🔄 पुन्हा बनवले</b>: {redo}/{settings.max_redos}")
        L.append(f"<b>⏳ मुदत</b>: {_e(fmt_ist(expiry))}")
        L.append("")
        L.append(_e(YT_TERMS_LINE))
        return "\n".join(L)

    desc_n, cap_n, claim_n = 1200, 700, 12
    details = build(desc_n, cap_n, claim_n)
    while utf16_len(details) > MESSAGE_LIMIT and (desc_n > 80 or cap_n > 80 or claim_n > 3):
        desc_n, cap_n = max(80, int(desc_n * 0.75)), max(80, int(cap_n * 0.75))
        claim_n = max(3, claim_n - 2)
        details = build(desc_n, cap_n, claim_n)
    if utf16_len(details) > MESSAGE_LIMIT:
        details = _cut_lines(details, MESSAGE_LIMIT)
    return caption, details


def _cut_lines(text: str, limit: int) -> str:
    """Every line carries balanced tags, so cutting on a line boundary keeps the HTML valid."""
    tail = "\n…\n" + _e(YT_TERMS_LINE)
    out, used = [], utf16_len(tail)
    for line in text.split("\n"):
        n = utf16_len(line) + 1
        if used + n > limit:
            break
        out.append(line)
        used += n
    return "\n".join(out) + tail


# ── keyboards ─────────────────────────────────────────────────────────────────


def _btn(text: str, act: str, approval_id: int, nonce: str) -> dict:
    data = f"{act}:{approval_id}:{nonce}"
    if not 1 <= len(data.encode("utf-8")) <= 64:   # not `assert`: python -O strips asserts
        raise ValueError(f"callback_data must be 1-64 bytes: {data!r}")
    return {"text": text, "callback_data": data}


def keyboard(approval_id: int, nonce: str, platforms: list[str], *,
             available: Sequence[str] = ALL_PLATFORMS) -> dict:
    sel = set(platforms)
    toggles = [
        _btn(("🧩 " if i == 0 else "") + f"{PLATFORM_LABEL[p]} {_mark(p in sel)}", f"p{p}", approval_id, nonce)
        for i, p in enumerate(p for p in ALL_PLATFORMS if p in available)
    ]
    return {"inline_keyboard": [
        [_btn("✅ मंजूर", "a", approval_id, nonce), _btn("⚡ आत्ताच", "n", approval_id, nonce)],
        toggles,
        [_btn("✏️ बदल", "e", approval_id, nonce), _btn("🔄 पुन्हा", "r", approval_id, nonce),
         _btn("⏭ वगळा", "s", approval_id, nonce)],
    ]}


EDIT_FIELDS = {"et": ("yt_title", "YouTube शीर्षक"), "ei": ("ig_caption", "Instagram कॅप्शन"),
               "ef": ("fb_caption", "Facebook कॅप्शन")}
REDO_REASONS = {"rl": "भाषा", "rm": "माहिती", "rv": "दृश्य", "ro": "इतर"}


def edit_menu(approval_id: int, nonce: str) -> dict:
    rows = [[_btn(f"✏️ {label}", code, approval_id, nonce)] for code, (_, label) in EDIT_FIELDS.items()]
    return {"inline_keyboard": [*rows, [_btn("↩️ मागे", "b", approval_id, nonce)]]}


def redo_menu(approval_id: int, nonce: str) -> dict:
    b = {code: _btn(f"🔄 {label}", code, approval_id, nonce) for code, label in REDO_REASONS.items()}
    return {"inline_keyboard": [[b["rl"], b["rm"]], [b["rv"], b["ro"]], [_btn("↩️ मागे", "b", approval_id, nonce)]]}


# ── sending / closing cards ───────────────────────────────────────────────────


def send_card(
    conn: sqlite3.Connection,
    tg: TelegramClient,
    *,
    chat_id: int | str,
    revision_row: Any,
    video_row: Any,
    slot_row: Any,
    settings: Settings,
    platforms: Sequence[str] | None = None,
    cost_inr: float | None = None,
    now: datetime | None = None,
) -> int:
    """Create a pending approval for the revision and send its two messages. Returns approval id.

    Any older pending approval of the same revision is superseded first (re-send after
    ~20 h, because Telegram drops button taps after 24 h) and its buttons removed.
    The approval row exists before anything is sent, so a tap can always be verified.
    """
    now = now or utcnow()
    revision_id = int(_g(revision_row, "id"))
    content_hash = str(_g(revision_row, "content_hash", "")) or ""
    if not content_hash:
        raise ValueError(f"revision {revision_id} has no content_hash; an approval must bind to one")
    if platforms is None:
        platforms = _j(revision_row, "metadata_json").get("platforms") or list(settings.platforms)
    platforms = [p for p in platforms if p in ALL_PLATFORMS]
    nonce = new_nonce()
    with tx(conn):
        if conn.execute("SELECT 1 FROM approvals WHERE revision_id=? AND status=?",
                        (revision_id, ApprovalStatus.APPROVED.value)).fetchone():
            raise ValueError(f"revision {revision_id} is already approved; not re-sending")
        old = conn.execute("SELECT id, message_ids_json, decision_json FROM approvals"
                           " WHERE revision_id=? AND status=?",
                           (revision_id, ApprovalStatus.PENDING.value)).fetchall()
        if any(o["decision_json"] for o in old):
            # The founder already tapped; superseding now would silently drop that decision.
            raise ValueError(f"revision {revision_id} has a recorded decision the state machine "
                             "has not applied yet (see callbacks.pending_decisions)")
        conn.execute("UPDATE approvals SET status=? WHERE revision_id=? AND status=?",
                     (ApprovalStatus.SUPERSEDED.value, revision_id, ApprovalStatus.PENDING.value))
        cur = conn.execute(
            "INSERT INTO approvals(revision_id, content_hash, nonce, status, platforms_json, sent_at)"
            " VALUES (?,?,?,?,?,?)",
            (revision_id, content_hash, nonce, ApprovalStatus.PENDING.value, json.dumps(platforms), iso(now)),
        )
        approval_id = int(cur.lastrowid)
    for o in old:
        close_card(tg, chat_id, json.loads(o["message_ids_json"] or "[]"), None)

    caption, details = card_texts(revision_row, video_row, slot_row, settings,
                                  platforms=platforms, cost_inr=cost_inr)
    ids: list[int] = []

    def keep(message_id: int) -> None:
        # Persist after each send so a half-sent card can still be closed when superseded.
        ids.append(message_id)
        conn.execute("UPDATE approvals SET message_ids_json=? WHERE id=?", (json.dumps(ids), approval_id))

    preview = _g(revision_row, "preview_path")
    if preview:
        keep(tg.send_video(chat_id, preview, caption, None, width=720, height=1280,
                           duration=int(_g(revision_row, "duration_s", 0) or 0) or None))
    else:
        keep(tg.send_message(chat_id, caption, parse_mode=None))
    keep(tg.send_message(chat_id, details, keyboard(approval_id, nonce, list(platforms))))
    log_event(conn, "approval_card_sent", _g(video_row, "id"), approval_id=approval_id,
              revision_id=revision_id, superseded=[o["id"] for o in old])
    return approval_id


def close_card(tg: TelegramClient, chat_id: int | str, message_ids: Sequence[int], status_text: str | None) -> None:
    """Best effort: drop the card's buttons and, if given, send a short status message.

    Called by the state machine after it has applied a decision (or superseded/expired the card).
    """
    if not message_ids:
        return
    details_id = message_ids[-1]
    try:
        tg.edit_reply_markup(chat_id, details_id, None)
        if status_text:
            tg.send_message(chat_id, status_text, parse_mode=None)
    except TelegramError:
        pass  # an old message may be gone/uneditable (48 h edit window); the DB is the truth
