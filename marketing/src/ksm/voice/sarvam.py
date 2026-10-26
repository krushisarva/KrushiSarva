"""Sarvam text-to-speech (bulbul:v4-flash) and the sentence splitter that feeds it.

One request per sentence: Sarvam returns no word timings, so caption timing comes
from each sentence clip's measured length (see voice/timeline.py).
"""
from __future__ import annotations

import base64
import binascii
import io
import time
import wave
from typing import Callable

import httpx
import regex

# ── Sentence splitting ────────────────────────────────────────────────────────
# Port of VOICE_SENTENCE_BOUNDARY / _nextVoiceSentence (backend/src/routes/ai.routes.js).
# A '.' is a sentence end only when it is not a decimal point: cutting "2.5" into two clips
# makes the voice say "two." and "five" as separate falling sentences. \p{Nd} also covers
# Devanagari digits (२.५); । and newlines are never decimal separators.
VOICE_SENTENCE_BOUNDARY = regex.compile(r"(?<!\p{Nd})[.!?](?=\s|\Z)|[।\n]")
VOICE_TTS_MIN_CHARS = 12    # don't synthesise tiny fragments; merge them forward
VOICE_TTS_MAX_CHARS = 180   # force a cut at a space if one "sentence" runs long
# "रु. ४,३५०" must stay one clip: a '.' that ends one of these abbreviations is not a sentence end
# (the JS original splits here; in narration that makes the voice say "rupees." and pause).
_ABBREV_BEFORE_DOT = regex.compile(r"(?:^|[\s(])(?:रु|Rs|rs|डॉ|Dr|क्विं|कि|मि)\Z")


def split_sentences(text: str) -> list[str]:
    """Split narration into 12..180-char sentences, never inside a number.

    Unlike the streaming JS original (which waits for more input when a sentence is
    short), the whole text is known here, so a short sentence is merged with the next
    one, and a short trailing fragment joins the previous sentence when it fits.
    """
    out: list[str] = []
    pos, n = 0, len(text)
    while pos < n:
        while pos < n and text[pos].isspace():
            pos += 1
        if pos >= n:
            break
        rest = text[pos:]
        end = len(rest)
        for m in VOICE_SENTENCE_BOUNDARY.finditer(rest):
            if m.group() == "." and _ABBREV_BEFORE_DOT.search(rest, 0, m.start()):
                continue
            if len(rest[: m.end()].strip()) >= VOICE_TTS_MIN_CHARS:
                end = m.end()
                break
        if len(rest[:end].strip()) > VOICE_TTS_MAX_CHARS:
            cut = rest.rfind(" ", 0, VOICE_TTS_MAX_CHARS + 1)
            end = cut if cut >= VOICE_TTS_MIN_CHARS else VOICE_TTS_MAX_CHARS
        piece = rest[:end].strip()
        if piece:
            out.append(piece)
        pos += end
    if len(out) >= 2 and len(out[-1]) < VOICE_TTS_MIN_CHARS:
        joined = f"{out[-2]} {out[-1]}"
        if len(joined) <= VOICE_TTS_MAX_CHARS:
            out[-2:] = [joined]
    return out


# ── Sarvam client ─────────────────────────────────────────────────────────────


class SarvamError(RuntimeError):
    """Sarvam TTS failed (non-retryable status, exhausted retries, or bad audio)."""


RETRY_STATUS = frozenset({429, 500, 502, 503, 504})


class SarvamTTS:
    URL = "https://api.sarvam.ai/text-to-speech"
    MAX_CHARS = 2500            # per request on bulbul:v3 / v4-flash
    TIMEOUT_S = 30.0
    # The backend (bulbul:v3) sends target_language_code; the 2026 API reference example shows
    # 'language_code'. A 400/422 that names the field switches to the other name once (sticky).
    LANGUAGE_FIELD = "target_language_code"
    ALT_LANGUAGE_FIELD = "language_code"

    def __init__(self, api_key: str, client: httpx.Client | None = None, *, model: str = "bulbul:v4-flash",
                 speaker: str = "mrunal_mr_narration", sample_rate: int = 48000, dict_id: str | None = None,
                 language: str = "mr-IN", pace: float = 1.0, max_attempts: int = 4,
                 sleep: Callable[[float], None] = time.sleep) -> None:
        if model.startswith("bulbul:v4") and "_" not in speaker:
            # v4-flash only accepts persona ids (<name>_<lang>_<style>); v3 names like 'priya' are rejected.
            raise ValueError(f"speaker {speaker!r} is a v3 name; v4-flash needs a persona id like mrunal_mr_narration")
        self._key = api_key
        self._client = client or httpx.Client(timeout=self.TIMEOUT_S)
        self.model = model
        self.speaker = speaker
        self.sample_rate = sample_rate
        self.dict_id = dict_id
        self.language = language
        self.pace = pace
        self.max_attempts = max_attempts
        self._sleep = sleep
        self.language_field = self.LANGUAGE_FIELD
        self.chars_billed = 0       # for the cost ledger: characters of successful requests

    def request_body(self, text: str) -> dict:
        body = {
            "text": text,
            self.language_field: self.language,
            "speaker": self.speaker,
            "model": self.model,
            "speech_sample_rate": self.sample_rate,
            "pace": self.pace,
            # output_audio_codec omitted: WAV is the documented default.
        }
        if self.dict_id:
            body["dict_id"] = self.dict_id
        return body

    def synth(self, text: str) -> bytes:
        """Synthesise one sentence; returns WAV bytes."""
        text = text.strip()
        if not text:
            raise ValueError("empty text")
        if len(text) > self.MAX_CHARS:
            raise ValueError(f"text is {len(text)} chars; Sarvam accepts at most {self.MAX_CHARS}")
        headers = {"api-subscription-key": self._key, "Content-Type": "application/json"}
        body = self.request_body(text)
        last = ""
        switched = False
        for attempt in range(self.max_attempts):
            try:
                resp = self._client.post(self.URL, json=body, headers=headers, timeout=self.TIMEOUT_S)
            except httpx.TransportError as e:
                last = f"{type(e).__name__}"
                self._backoff(attempt, None)
                continue
            if resp.status_code in RETRY_STATUS:
                last = f"HTTP {resp.status_code}"
                self._backoff(attempt, resp.headers.get("retry-after"))
                continue
            if resp.status_code in (400, 422) and not switched and self._names_language_field(resp.text):
                switched = True
                self.language_field = (self.ALT_LANGUAGE_FIELD if self.language_field == self.LANGUAGE_FIELD
                                       else self.LANGUAGE_FIELD)
                body = self.request_body(text)
                continue
            if resp.status_code >= 400:
                raise SarvamError(f"Sarvam TTS failed (HTTP {resp.status_code}): {resp.text[:300]}")
            self.chars_billed += len(text)      # a 200 is billed even if the audio turns out unusable
            try:
                payload = resp.json()
            except ValueError as e:
                raise SarvamError(f"Sarvam returned non-JSON: {resp.text[:200]}") from e
            return _decode_audios(payload)
        raise SarvamError(f"Sarvam TTS failed after {self.max_attempts} attempts ({last})")

    def _names_language_field(self, err: str) -> bool:
        return self.LANGUAGE_FIELD in err or self.ALT_LANGUAGE_FIELD in err

    def _backoff(self, attempt: int, retry_after: str | None) -> None:
        if attempt + 1 >= self.max_attempts:
            return
        delay = 2.0 ** attempt
        if retry_after:
            try:
                delay = max(delay, float(retry_after))
            except ValueError:
                pass
        self._sleep(min(delay, 30.0))


def _decode_audios(payload: dict) -> bytes:
    audios = payload.get("audios") if isinstance(payload, dict) else None
    if not audios or not isinstance(audios, list):
        raise SarvamError("Sarvam response has no 'audios'")
    try:
        clips = [base64.b64decode(a, validate=True) for a in audios]
    except (binascii.Error, TypeError) as e:
        raise SarvamError(f"Sarvam audio is not valid base64: {e}") from e
    for c in clips:
        if c[:4] != b"RIFF" or c[8:12] != b"WAVE":
            raise SarvamError("Sarvam audio is not a WAV file")
        # Parse it now so a non-PCM (e.g. float) or empty clip fails here as a SarvamError,
        # not later inside synthesize() as a bare wave.Error or a silent zero-length sentence.
        try:
            with wave.open(io.BytesIO(c), "rb") as w:
                if w.getsampwidth() != 2 or w.readframes(1) == b"":
                    raise SarvamError(f"Sarvam audio is not 16-bit PCM with samples "
                                      f"(sampwidth={w.getsampwidth()})")
        except (wave.Error, EOFError) as e:
            raise SarvamError(f"Sarvam audio is not a readable PCM WAV: {e}") from e
    return clips[0] if len(clips) == 1 else join_wavs(clips)


def join_wavs(clips: list[bytes]) -> bytes:
    """Concatenate WAV clips that share one format (Sarvam may split long input)."""
    params = None
    frames: list[bytes] = []
    for c in clips:
        with wave.open(io.BytesIO(c), "rb") as w:
            p = (w.getnchannels(), w.getsampwidth(), w.getframerate())
            if params is None:
                params = p
            elif p != params:
                raise SarvamError(f"Sarvam clips differ in format: {p} vs {params}")
            frames.append(w.readframes(w.getnframes()))
    assert params is not None
    buf = io.BytesIO()
    with wave.open(buf, "wb") as out:
        out.setnchannels(params[0])
        out.setsampwidth(params[1])
        out.setframerate(params[2])
        out.writeframes(b"".join(frames))
    return buf.getvalue()
