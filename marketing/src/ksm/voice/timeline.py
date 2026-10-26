"""Narration assembly and caption timing.

Each sentence is synthesised separately and its duration measured from the WAV sample
count; the clips are joined with fixed gaps into narration.wav, so every sentence's
start time is known exactly. Captions inside a sentence are timed by grapheme share.
"""
from __future__ import annotations

import array
import hashlib
import io
import os
import wave
from pathlib import Path
from typing import Protocol

import regex

from ..models import SentenceAudio, Timeline, VideoScript
from .sarvam import split_sentences


class TTS(Protocol):
    def synth(self, text: str) -> bytes: ...


# ── WAV helpers ───────────────────────────────────────────────────────────────


def read_wav(data: bytes | Path) -> tuple[tuple[int, int, int], bytes]:
    """-> ((channels, sampwidth, rate), pcm frames). Durations are measured from the bytes actually
    read (an oversized streaming-style data size reads to EOF); a trailing partial frame is dropped."""
    src = io.BytesIO(data) if isinstance(data, (bytes, bytearray)) else open(data, "rb")
    with src, wave.open(src, "rb") as w:
        params = (w.getnchannels(), w.getsampwidth(), w.getframerate())
        frames = w.readframes(w.getnframes())
    frame_size = params[0] * params[1]
    return params, frames[: len(frames) - len(frames) % frame_size]


def wav_duration(path: Path) -> float:
    (ch, sw, rate), frames = read_wav(path)
    return len(frames) / (ch * sw) / rate


def _convert_channels(frames: bytes, sampwidth: int, src: int, dst: int) -> bytes:
    if src == dst:
        return frames
    if sampwidth != 2 or {src, dst} != {1, 2}:
        raise ValueError(f"cannot convert {src}->{dst} channels at {sampwidth * 8}-bit")
    a = array.array("h")
    a.frombytes(frames)
    if src == 1:            # mono -> stereo: duplicate each sample
        out = array.array("h", (s for s in a for _ in (0, 1)))
    else:                   # stereo -> mono: average the pair
        out = array.array("h", ((a[i] + a[i + 1]) // 2 for i in range(0, len(a), 2)))
    return out.tobytes()


def _write_wav(path: Path, params: tuple[int, int, int], frames: bytes) -> None:
    tmp = path.with_suffix(".part.wav")
    with wave.open(str(tmp), "wb") as w:
        w.setnchannels(params[0])
        w.setsampwidth(params[1])
        w.setframerate(params[2])
        w.writeframes(frames)
    os.replace(tmp, path)


# ── Synthesis ─────────────────────────────────────────────────────────────────


def _clip_key(tts: object, text: str) -> str:
    attrs = ("model", "speaker", "sample_rate", "dict_id", "pace", "language")
    ident = "|".join(str(getattr(tts, a, "")) for a in attrs)
    return hashlib.sha256(f"{ident}|{text}".encode()).hexdigest()[:12]


def synthesize(script: VideoScript, tts: TTS, out_dir: Path, gap_s: float = 0.18) -> Timeline:
    """One TTS request per sentence -> s###-<hash>.wav clips + narration.wav.

    Clips are keyed by (voice settings, text), so a re-run after a crash only pays for
    sentences that were not yet synthesised.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    parts = script.narration()
    n_seg = len(script.segments)
    indices = [-1, *range(n_seg), n_seg]
    expected_rate = getattr(tts, "sample_rate", None)

    sentences: list[SentenceAudio] = []
    pcm: list[bytes] = []
    fmt: tuple[int, int, int] | None = None
    k = 0
    for seg_idx, text in zip(indices, parts, strict=True):
        for sentence in split_sentences(text):
            path = out_dir / f"s{k:03d}-{_clip_key(tts, sentence)}.wav"
            if not path.exists():
                params, frames = read_wav(tts.synth(sentence))
                # Check before caching: a bad clip in the cache would fail every re-run.
                if expected_rate and params[2] != expected_rate:
                    raise ValueError(f"TTS returned {params[2]} Hz for {sentence[:30]!r}, expected {expected_rate} Hz")
                if not frames:
                    raise ValueError(f"TTS returned no audio for {sentence[:30]!r}")
                _write_wav(path, params, frames)
            params, frames = read_wav(path)
            if expected_rate and params[2] != expected_rate:
                raise ValueError(f"{path.name}: {params[2]} Hz, expected {expected_rate} Hz")
            if fmt is None:
                fmt = params
            elif params != fmt:
                if params[1:] != fmt[1:]:
                    raise ValueError(f"{path.name}: format {params} differs from {fmt}")
                frames = _convert_channels(frames, params[1], params[0], fmt[0])
            frame_size = fmt[0] * fmt[1]
            sentences.append(SentenceAudio(text=sentence, wav=path,
                                           duration_s=len(frames) / frame_size / fmt[2], segment_index=seg_idx))
            pcm.append(frames)
            k += 1
    if fmt is None:
        raise ValueError("script has no narration")

    gap = b"\x00" * (round(gap_s * fmt[2]) * fmt[0] * fmt[1])
    narration = out_dir / "narration.wav"
    _write_wav(narration, fmt, gap.join(pcm))
    return Timeline(sentences=sentences, gap_s=gap_s, narration_wav=narration)


def sentence_starts(timeline: Timeline) -> list[float]:
    """Start time (s) of each sentence inside narration.wav."""
    t, out = 0.0, []
    for s in timeline.sentences:
        out.append(t)
        t += s.duration_s + timeline.gap_s
    return out


def timeline_to_dict(tl: Timeline) -> dict:
    return {"gap_s": tl.gap_s, "narration_wav": str(tl.narration_wav),
            "sentences": [{"text": s.text, "wav": str(s.wav), "duration_s": s.duration_s,
                           "segment_index": s.segment_index} for s in tl.sentences]}


def timeline_from_dict(d: dict) -> Timeline:
    return Timeline(
        sentences=[SentenceAudio(text=s["text"], wav=Path(s["wav"]), duration_s=float(s["duration_s"]),
                                 segment_index=int(s["segment_index"])) for s in d["sentences"]],
        gap_s=float(d["gap_s"]), narration_wav=Path(d["narration_wav"]))


# ── Caption chunks ────────────────────────────────────────────────────────────

_GRAPHEME = regex.compile(r"\X")
_WEIGHTED = regex.compile(r"[\p{L}\p{N}\p{Sc}]")
MAX_WORDS = 5


def graphemes(s: str) -> list[str]:
    return _GRAPHEME.findall(s)


def glen(s: str) -> int:
    return len(graphemes(s))


def _weight(s: str) -> int:
    """Spoken-length proxy: graphemes that are letters/digits/currency (no spaces, punctuation)."""
    return sum(1 for g in graphemes(s) if _WEIGHTED.search(g))


def _group_words(words: list[str], max_g: int) -> list[list[str]]:
    chunks: list[list[str]] = []
    cur: list[str] = []
    for w in words:
        if glen(w) > max_g:                         # a single over-long word: hard-split by grapheme
            if cur:
                chunks.append(cur)
                cur = []
            gs = graphemes(w)
            chunks.extend([["".join(gs[i:i + max_g])] for i in range(0, len(gs), max_g)])
            continue
        if cur and (len(cur) >= MAX_WORDS or glen(" ".join([*cur, w])) > max_g):
            chunks.append(cur)
            cur = [w]
        else:
            cur.append(w)
    if cur:
        chunks.append(cur)
    # Avoid a lone trailing word: move words back from the previous chunk when that one can spare them.
    for i in range(1, len(chunks)):
        while len(chunks[i]) < 2 and len(chunks[i - 1]) > 2 \
                and glen(" ".join([chunks[i - 1][-1], *chunks[i]])) <= max_g:
            chunks[i].insert(0, chunks[i - 1].pop())
    return chunks


def chunk_captions(sentence: str, duration_s: float, start_s: float,
                   max_graphemes: int = 22, min_chunk_s: float = 0.6) -> list[tuple[float, float, str]]:
    """2-5 word caption chunks (<= max_graphemes each) timed by their share of spoken graphemes.

    Chunks shorter than min_chunk_s are merged into a neighbour when the merged text still fits
    (graphemes and MAX_WORDS);
    otherwise they borrow time from the longer neighbour. Chunk times tile [start, start+duration].
    """
    words = sentence.split()
    if not words or duration_s <= 0:
        return []
    texts = [" ".join(c) for c in _group_words(words, max_graphemes)]
    weights = [max(_weight(t), 1) for t in texts]
    total_w = sum(weights)
    durs = [duration_s * w / total_w for w in weights]

    for _ in range(4 * len(texts)):                 # bounded: every pass merges or fixes one chunk
        if len(texts) < 2:
            break
        i = min(range(len(durs)), key=durs.__getitem__)
        if durs[i] >= min_chunk_s - 1e-9:
            break
        neighbours = [j for j in (i - 1, i + 1) if 0 <= j < len(texts)]
        neighbours.sort(key=lambda j: durs[j])
        merged = False
        for j in neighbours:
            a, b = min(i, j), max(i, j)
            joined = f"{texts[a]} {texts[b]}"
            if glen(joined) <= max_graphemes and len(joined.split()) <= MAX_WORDS:
                texts[a:b + 1] = [joined]
                durs[a:b + 1] = [durs[a] + durs[b]]
                merged = True
                break
        if merged:
            continue
        donor = max(neighbours, key=lambda j: durs[j])
        need = min_chunk_s - durs[i]
        if durs[donor] - need >= min_chunk_s:
            durs[donor] -= need
            durs[i] = min_chunk_s
        else:                                        # nothing fits: merge anyway (too little time)
            a, b = min(i, donor), max(i, donor)
            texts[a:b + 1] = [f"{texts[a]} {texts[b]}"]
            durs[a:b + 1] = [durs[a] + durs[b]]

    out: list[tuple[float, float, str]] = []
    t = start_s
    for k, (text, d) in enumerate(zip(texts, durs)):
        end = start_s + duration_s if k == len(texts) - 1 else t + d
        out.append((t, end, text))
        t = end
    return out
