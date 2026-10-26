"""Minimal Telegram Bot API client over raw httpx.

Why raw httpx and not python-telegram-bot: the approval flow uses five long-standing
methods, we want sync calls that fit the reconcile loop, and every HTTP call must be
mockable with respx.

The bot token is part of every URL, so this module never logs URLs and never lets an
httpx exception (whose message/request carries the URL) escape: failures surface as
TelegramError with the method name only.
"""
from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any, Callable

import httpx
import regex

log = logging.getLogger(__name__)

API_BASE = "https://api.telegram.org"
MAX_VIDEO_BYTES = 50 * 1024 * 1024      # sendVideo multipart limit
CAPTION_LIMIT = 1024                    # media caption, after entity parsing
MESSAGE_LIMIT = 4096                    # message text, after entity parsing
CALLBACK_ANSWER_LIMIT = 200
ALLOWED_UPDATES = ["message", "callback_query"]

_GRAPHEME = regex.compile(r"\X")
_TOKEN_IN_URL = regex.compile(r"/bot\d+:[A-Za-z0-9_-]+")


class _RedactTokenFilter(logging.Filter):
    """httpx logs every request URL at INFO, and Bot API URLs contain the token."""

    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        if "/bot" in msg:
            record.msg, record.args = _TOKEN_IN_URL.sub("/bot<redacted>", msg), ()
        return True


_REDACT = _RedactTokenFilter()


def _install_redaction() -> None:
    for name in ("httpx", "httpcore"):
        lg = logging.getLogger(name)
        if _REDACT not in lg.filters:
            lg.addFilter(_REDACT)


class TelegramError(RuntimeError):
    """A Bot API failure. Carries the method and Telegram's description, never the URL/token."""

    def __init__(self, method: str, code: int | None, description: str, retry_after: float | None = None):
        super().__init__(f"telegram {method} failed ({code}): {description}")
        self.method = method
        self.code = code
        self.description = description
        self.retry_after = retry_after


def utf16_len(s: str) -> int:
    """Telegram measures text lengths in UTF-16 code units (emoji outside the BMP count 2)."""
    return len(s.encode("utf-16-le")) // 2


def truncate(s: str, limit: int, ellipsis: str = "…") -> str:
    """Cut to <= limit UTF-16 units without splitting a grapheme (Devanagari conjuncts, emoji)."""
    if utf16_len(s) <= limit:
        return s
    budget = limit - utf16_len(ellipsis)
    out: list[str] = []
    used = 0
    for g in _GRAPHEME.findall(s):
        n = utf16_len(g)
        if used + n > budget:
            break
        out.append(g)
        used += n
    return "".join(out).rstrip() + ellipsis


class TelegramClient:
    """Sync Bot API client with retry on 429 (honouring retry_after), 5xx and transport errors."""

    def __init__(
        self,
        token: str,
        client: httpx.Client | None = None,
        *,
        max_attempts: int = 4,
        sleep: Callable[[float], None] = time.sleep,
        base_url: str = API_BASE,
    ):
        if not token:
            raise ValueError("telegram token is empty")
        self._token = token
        _install_redaction()
        self._http = client or httpx.Client(timeout=httpx.Timeout(30.0, connect=10.0))
        self._max_attempts = max_attempts
        self._sleep = sleep
        self._base = base_url.rstrip("/")

    def __repr__(self) -> str:  # never show the token
        return "TelegramClient(<token hidden>)"

    # ── transport ────────────────────────────────────────────────────────────

    def _url(self, method: str) -> str:
        return f"{self._base}/bot{self._token}/{method}"

    def call(
        self,
        method: str,
        data: dict[str, Any] | None = None,
        *,
        files: Callable[[], dict[str, Any]] | None = None,
        timeout: float | None = None,
    ) -> Any:
        """POST a Bot API method and return its `result`.

        `files` is a factory so a retried multipart upload re-opens the file instead of
        sending an exhausted stream.
        """
        payload = {k: v for k, v in (data or {}).items() if v is not None}
        delay = 1.0
        last: TelegramError | None = None
        for attempt in range(1, self._max_attempts + 1):
            opened: dict[str, Any] = {}
            try:
                kwargs: dict[str, Any] = {}
                if timeout is not None:
                    kwargs["timeout"] = timeout
                if files is not None:
                    opened = files()
                    form = {k: v if isinstance(v, str) else json.dumps(v) for k, v in payload.items()}
                    resp = self._http.post(self._url(method), data=form, files=opened, **kwargs)
                else:
                    resp = self._http.post(self._url(method), json=payload, **kwargs)
            except httpx.TransportError as e:
                # str(e) may embed the URL (and so the token); keep only the class name.
                last = TelegramError(method, None, type(e).__name__)
                log.warning("telegram %s transport error %s (attempt %d)", method, type(e).__name__, attempt)
                if attempt < self._max_attempts:
                    self._sleep(delay)
                    delay *= 2
                continue
            finally:
                for f in opened.values():
                    fh = f[1] if isinstance(f, tuple) and len(f) > 1 else f
                    if hasattr(fh, "close"):
                        fh.close()

            body = _json_or_none(resp)
            if resp.status_code == 200 and body and body.get("ok"):
                return body.get("result")
            desc = (body or {}).get("description") or f"HTTP {resp.status_code}"
            params = (body or {}).get("parameters") or {}
            if resp.status_code == 429:
                wait = float(params.get("retry_after") or delay)
                last = TelegramError(method, 429, desc, retry_after=wait)
                log.warning("telegram %s rate limited; retry after %.0fs", method, wait)
                if attempt < self._max_attempts:
                    self._sleep(wait)
                continue
            if resp.status_code >= 500:
                last = TelegramError(method, resp.status_code, desc)
                log.warning("telegram %s server error %d (attempt %d)", method, resp.status_code, attempt)
                if attempt < self._max_attempts:
                    self._sleep(delay)
                    delay *= 2
                continue
            raise TelegramError(method, resp.status_code, desc)
        assert last is not None
        raise last

    # ── methods ──────────────────────────────────────────────────────────────

    def get_me(self) -> dict:
        return self.call("getMe")

    def get_updates(self, offset: int | None, timeout: int = 50) -> list[dict]:
        """Long poll. The HTTP read timeout must outlive Telegram's own `timeout`."""
        return self.call(
            "getUpdates",
            {"offset": offset, "timeout": timeout, "allowed_updates": ALLOWED_UPDATES},
            timeout=timeout + 15,
        ) or []

    def send_video(
        self,
        chat_id: int | str,
        path: Path,
        caption: str,
        reply_markup: dict | None,
        *,
        width: int | None = None,
        height: int | None = None,
        duration: int | None = None,
    ) -> int:
        path = Path(path)
        size = path.stat().st_size
        if size > MAX_VIDEO_BYTES:
            raise ValueError(f"preview is {size} bytes; Telegram bots may upload at most {MAX_VIDEO_BYTES}")
        data = {
            "chat_id": str(chat_id),
            "caption": truncate(caption, CAPTION_LIMIT),
            "supports_streaming": "true",
            "reply_markup": reply_markup,
            "width": None if width is None else str(width),
            "height": None if height is None else str(height),
            "duration": None if duration is None else str(duration),
        }
        result = self.call(
            "sendVideo",
            data,
            files=lambda: {"video": (path.name, open(path, "rb"), "video/mp4")},
            timeout=300.0,
        )
        return int(result["message_id"])

    def send_message(
        self, chat_id: int | str, text: str, reply_markup: dict | None = None, parse_mode: str | None = "HTML"
    ) -> int:
        if utf16_len(text) > MESSAGE_LIMIT:
            if parse_mode:
                # Cutting formatted text could split a tag; cards.py sizes HTML itself.
                raise ValueError(f"message text exceeds {MESSAGE_LIMIT} UTF-16 units")
            text = truncate(text, MESSAGE_LIMIT)
        result = self.call(
            "sendMessage",
            {"chat_id": chat_id, "text": text, "parse_mode": parse_mode, "reply_markup": reply_markup,
             "link_preview_options": {"is_disabled": True}},
        )
        return int(result["message_id"])

    def edit_caption(
        self, chat_id: int | str, message_id: int, caption: str, reply_markup: dict | None = None
    ) -> None:
        self._edit("editMessageCaption", {"chat_id": chat_id, "message_id": message_id,
                                          "caption": truncate(caption, CAPTION_LIMIT),
                                          "reply_markup": reply_markup})

    def edit_text(
        self, chat_id: int | str, message_id: int, text: str, reply_markup: dict | None = None,
        parse_mode: str | None = "HTML",
    ) -> None:
        self._edit("editMessageText", {"chat_id": chat_id, "message_id": message_id, "text": text,
                                       "parse_mode": parse_mode, "reply_markup": reply_markup,
                                       "link_preview_options": {"is_disabled": True}})

    def edit_reply_markup(self, chat_id: int | str, message_id: int, reply_markup: dict | None = None) -> None:
        """reply_markup=None removes the inline keyboard."""
        self._edit("editMessageReplyMarkup", {"chat_id": chat_id, "message_id": message_id,
                                              "reply_markup": reply_markup or {"inline_keyboard": []}})

    def answer_callback(self, callback_id: str, text: str = "", show_alert: bool = False) -> None:
        self.call("answerCallbackQuery", {"callback_query_id": callback_id,
                                          "text": truncate(text, CALLBACK_ANSWER_LIMIT) if text else None,
                                          "show_alert": show_alert or None})

    def _edit(self, method: str, data: dict) -> None:
        try:
            self.call(method, data)
        except TelegramError as e:
            # Re-applying the same edit (e.g. after a restart) is not an error for us.
            if e.code == 400 and "not modified" in e.description.lower():
                return
            raise


def _json_or_none(resp: httpx.Response) -> dict | None:
    try:
        body = resp.json()
    except ValueError:
        return None
    return body if isinstance(body, dict) else None
