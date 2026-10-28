"""Technical QA of a rendered master: container/stream specs, loudness, black frames, silence.

Everything is read back from the file with ffprobe/ffmpeg, so QA checks what will be
uploaded, not what the render command intended.
"""
from __future__ import annotations

import json
import re
import struct
import subprocess
from pathlib import Path
from typing import Callable

from ..models import QAReport
from .ffmpeg import ffmpeg_bin, ffprobe_bin

Runner = Callable[..., subprocess.CompletedProcess]

MIN_S, MAX_S = 15.0, 58.0
MAX_BYTES = 100 * 1024 * 1024
TARGET_LUFS, LUFS_TOL = -14.0, 1.0
MAX_TRUE_PEAK = -1.0
BLACK_MAX_S = 0.5
SILENCE_MAX_S = 1.2


def atom_order(path: Path, limit: int = 64) -> list[str]:
    """Top-level MP4 box types in file order (reads headers only)."""
    out: list[str] = []
    size_total = path.stat().st_size
    with open(path, "rb") as f:
        pos = 0
        while pos < size_total and len(out) < limit:
            f.seek(pos)
            hdr = f.read(8)
            if len(hdr) < 8:
                break
            size, kind = struct.unpack(">I4s", hdr)
            if size == 1:
                size = struct.unpack(">Q", f.read(8))[0]
            elif size == 0:
                size = size_total - pos
            out.append(kind.decode("latin-1"))
            if size < 8:
                break
            pos += size
    return out


def moov_before_mdat(path: Path) -> bool:
    atoms = atom_order(path)
    return "moov" in atoms and "mdat" in atoms and atoms.index("moov") < atoms.index("mdat")


def _rate(s: str | None) -> float:
    if not s or s in ("0/0",):
        return 0.0
    num, _, den = s.partition("/")
    return float(num) / float(den or 1)


def check_streams(info: dict) -> list[str]:
    problems: list[str] = []
    streams = info.get("streams") or []
    v = next((s for s in streams if s.get("codec_type") == "video"), None)
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if v is None:
        problems.append("no video stream")
    else:
        if (v.get("width"), v.get("height")) != (1080, 1920):
            problems.append(f"video is {v.get('width')}x{v.get('height')}, expected 1080x1920")
        if v.get("codec_name") != "h264" or (v.get("profile") or "") != "High":
            problems.append(f"video codec {v.get('codec_name')} {v.get('profile')}, expected h264 High")
        if v.get("pix_fmt") != "yuv420p":
            problems.append(f"pix_fmt {v.get('pix_fmt')}, expected yuv420p")
        fps = _rate(v.get("avg_frame_rate")) or _rate(v.get("r_frame_rate"))
        if abs(fps - 30.0) > 0.01:
            problems.append(f"{fps:.3f} fps, expected 30")
    if a is None:
        problems.append("no audio stream")
    else:
        if a.get("codec_name") != "aac":
            problems.append(f"audio codec {a.get('codec_name')}, expected aac")
        if str(a.get("sample_rate")) != "48000":
            problems.append(f"audio {a.get('sample_rate')} Hz, expected 48000")
    fmt = info.get("format") or {}
    dur = float(fmt.get("duration") or 0)
    if not MIN_S <= dur <= MAX_S:
        problems.append(f"duration {dur:.1f} s outside {MIN_S:.0f}-{MAX_S:.0f} s")
    size = int(fmt.get("size") or 0)
    if size >= MAX_BYTES:
        problems.append(f"file is {size / 1e6:.1f} MB, must be < 100 MB")
    return problems


_EBUR_I = re.compile(r"Integrated loudness:\s*I:\s*(-?[\d.]+|-inf)\s*LUFS", re.S)
_EBUR_TP = re.compile(r"True peak:\s*Peak:\s*(-?[\d.]+|-inf)\s*dBFS", re.S)
_BLACK = re.compile(r"black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)\s+black_duration:\s*([\d.]+)")
_SILENCE = re.compile(r"silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)")
_SILENCE_START = re.compile(r"silence_start:\s*(-?[\d.]+)")


def parse_ebur128(stderr: str) -> tuple[float | None, float | None]:
    """(integrated LUFS, true peak dBTP) from the ebur128 summary (the last one printed)."""
    i = _EBUR_I.findall(stderr)
    tp = _EBUR_TP.findall(stderr)
    f = lambda xs: float(xs[-1]) if xs and xs[-1] != "-inf" else None  # noqa: E731
    return f(i), f(tp)


def parse_blackdetect(stderr: str) -> list[tuple[float, float, float]]:
    return [tuple(map(float, m)) for m in _BLACK.findall(stderr)]


def parse_silencedetect(stderr: str, total_s: float | None = None) -> list[tuple[float, float]]:
    """[(start, duration)] — a silence still open at EOF gets its duration from total_s."""
    out = [(float(e) - float(d), float(d)) for e, d in _SILENCE.findall(stderr)]
    starts = [float(s) for s in _SILENCE_START.findall(stderr)]
    if total_s is not None and len(starts) > len(out):
        s = starts[-1]
        out.append((s, total_s - s))
    return out


def analysis_command(master: Path, *, ffmpeg: str) -> list[str]:
    return [ffmpeg, "-hide_banner", "-nostats", "-i", str(master), "-filter_complex",
            f"[0:v]blackdetect=d={BLACK_MAX_S}:pix_th=0.10[v];"
            f"[0:a]ebur128=peak=true,silencedetect=noise=-50dB:d={SILENCE_MAX_S}[a]",
            "-map", "[v]", "-map", "[a]", "-f", "null", "-"]


def probe(master: Path, *, runner: Runner = subprocess.run, ffmpeg: str | None = None,
          ffprobe: str | None = None) -> QAReport:
    ff = ffmpeg or ffmpeg_bin(runner=runner)
    fp = ffprobe or ffprobe_bin(ff)
    problems: list[str] = []
    try:
        res = runner([fp, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(master)],
                     capture_output=True, text=True, timeout=120)
    except (subprocess.TimeoutExpired, OSError) as e:
        return QAReport(ok=False, problems=[f"ffprobe failed: {e}"])
    if res.returncode != 0:
        return QAReport(ok=False, problems=[f"ffprobe failed: {res.stderr.strip()[-300:]}"])
    try:
        info = json.loads(res.stdout or "{}")
    except ValueError:
        return QAReport(ok=False, problems=["ffprobe printed unreadable JSON"])
    problems += check_streams(info)
    if not moov_before_mdat(master):
        problems.append("moov atom is not before mdat (faststart missing)")

    try:
        an = runner(analysis_command(master, ffmpeg=ff), capture_output=True, text=True, timeout=600)
    except (subprocess.TimeoutExpired, OSError) as e:
        problems.append(f"analysis failed: {e}")
        return QAReport(ok=False, problems=problems, probe=info)
    if an.returncode != 0:
        problems.append(f"analysis failed: {an.stderr.strip()[-300:]}")
        return QAReport(ok=False, problems=problems, probe=info)
    lufs, tp = parse_ebur128(an.stderr)
    if lufs is None or abs(lufs - TARGET_LUFS) > LUFS_TOL:
        problems.append(f"integrated loudness {lufs} LUFS, expected {TARGET_LUFS} ± {LUFS_TOL}")
    if tp is None or tp > MAX_TRUE_PEAK:
        problems.append(f"true peak {tp} dBTP, must be <= {MAX_TRUE_PEAK}")
    blacks = parse_blackdetect(an.stderr)
    for start, _end, dur in blacks:
        problems.append(f"black frames {dur:.2f} s at {start:.2f} s")
    total = float((info.get("format") or {}).get("duration") or 0) or None
    silences = [s for s in parse_silencedetect(an.stderr, total) if s[1] > SILENCE_MAX_S]
    for start, dur in silences:
        problems.append(f"silence {dur:.2f} s at {start:.2f} s")
    info["qa"] = {"lufs": lufs, "true_peak": tp, "black": blacks, "silence": silences}
    return QAReport(ok=not problems, problems=problems, probe=info)
