"""ffmpeg-full command construction and the render pipeline.

Devanagari is only shaped correctly by libass built with HarfBuzz; Homebrew's plain
ffmpeg has no libass at all, so ffmpeg_bin() refuses anything that lacks it rather
than rendering broken text silently.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Callable, Sequence

from ..config import Settings, get_settings
from ..models import RenderOutputs, Timeline, VideoPlan, VideoScript
from .ass import build_ass, load_fonts, write_ass
from .cards import build_cards, card_kind
from .layout import END_CARD_S, H, STATIC_KINDS, WATERMARK_BOX, XFADE_S, W, load_brand, scene_spans

FFMPEG_FULL = "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg"
REQUIRED_FEATURES = ("libass", "libharfbuzz", "libfreetype")
FPS = 30
KB_SCALE = (1188, 2112)            # Ken Burns: 110% canvas, cropped back to 1080x1920 while panning
LOUDNORM = dict(I=-14.0, TP=-1.5, LRA=11.0)
PREVIEW_MAX_BYTES = 45 * 1024 * 1024

Runner = Callable[..., subprocess.CompletedProcess]


class FfmpegMissing(RuntimeError):
    pass


class ScriptTooLong(ValueError):
    """Narration + end card exceed settings.max_video_seconds: the writer must shorten the script."""


class RenderError(RuntimeError):
    pass


# ── Binary discovery ──────────────────────────────────────────────────────────


def parse_buildconf(text: str) -> set[str]:
    """'--enable-libass' flags from `ffmpeg -buildconf` -> {'libass', ...}."""
    return {tok[len("--enable-"):] for tok in text.split() if tok.startswith("--enable-")}


def _candidates() -> list[str]:
    out = []
    if env := os.environ.get("KSM_FFMPEG"):
        out.append(env)
    out.append(FFMPEG_FULL)
    if found := shutil.which("ffmpeg"):
        out.append(found)
    return out


def ffmpeg_bin(*, runner: Runner = subprocess.run) -> str:
    """Path to an ffmpeg with libass + harfbuzz + freetype; raises FfmpegMissing otherwise."""
    seen: list[str] = []
    for path in dict.fromkeys(_candidates()):
        if not (os.path.isfile(path) and os.access(path, os.X_OK)):
            continue
        try:
            res = runner([path, "-hide_banner", "-buildconf"], capture_output=True, text=True, timeout=20)
        except (OSError, subprocess.SubprocessError):
            continue
        missing = [f for f in REQUIRED_FEATURES if f not in parse_buildconf(res.stdout + res.stderr)]
        if not missing:
            return path
        seen.append(f"{path} (missing {', '.join(missing)})")
    raise FfmpegMissing(
        "No ffmpeg with libass, harfbuzz and freetype found"
        + (f": {'; '.join(seen)}" if seen else "")
        + ". Marathi text needs them. Run: brew install ffmpeg-full")


def ffprobe_bin(ffmpeg: str | None = None) -> str:
    base = ffmpeg or ffmpeg_bin()
    sibling = Path(base).with_name("ffprobe")
    if sibling.is_file():
        return str(sibling)
    found = shutil.which("ffprobe")
    if not found:
        raise FfmpegMissing("ffprobe not found. Run: brew install ffmpeg-full")
    return found


# ── Filtergraph helpers ───────────────────────────────────────────────────────


def _fg_path(p: Path) -> str:
    """Quote a path for a filter option. Characters that need multi-level escaping are refused."""
    s = str(p)
    bad = set("'\\:[],;") & set(s)
    if bad:
        raise ValueError(f"path not usable inside an ffmpeg filtergraph ({''.join(sorted(bad))}): {s}")
    return f"'{s}'"


def _f(x: float) -> str:
    return f"{x:.3f}"


def loudnorm_filter(measured: dict | None) -> str:
    base = f"loudnorm=I={LOUDNORM['I']}:TP={LOUDNORM['TP']}:LRA={LOUDNORM['LRA']}"
    if not measured:
        return base
    return (f"{base}:measured_I={measured['input_i']}:measured_TP={measured['input_tp']}"
            f":measured_LRA={measured['input_lra']}:measured_thresh={measured['input_thresh']}"
            f":offset={measured['target_offset']}:linear=true")


def loudnorm_measure_command(wav: Path, *, ffmpeg: str) -> list[str]:
    return [ffmpeg, "-hide_banner", "-nostats", "-i", str(wav),
            "-af", f"{loudnorm_filter(None)}:print_format=json", "-f", "null", "-"]


def parse_loudnorm_json(stderr: str) -> dict:
    """The JSON block loudnorm prints at the end of pass 1."""
    end = stderr.rfind("}")
    start = stderr.rfind("{", 0, end)
    if start < 0 or end < 0:
        raise RenderError("loudnorm printed no measurement")
    try:
        data = json.loads(stderr[start:end + 1])
        for k in ("input_i", "input_tp", "input_lra", "input_thresh", "target_offset"):
            float(data[k])
    except (ValueError, KeyError, TypeError) as e:
        raise RenderError(f"unreadable loudnorm measurement: {e}") from e
    return data


def render_command(cards: Sequence[Path], timeline: Timeline, ass_path: Path, out_master: Path, *,
                   fonts_dir: Path, watermark: Path, loudnorm: dict | None = None,
                   kenburns: Sequence[bool] | None = None, ffmpeg: str | None = None) -> list[str]:
    """One ffmpeg invocation: cards (looped, Ken Burns where allowed) -> xfade chain -> watermark ->
    ASS (shaping=complex) ; narration -> loudnorm -> 48 kHz AAC ; H.264 High master.

    cards are [hook, segment 0..n-1, end card]; scene i lasts its narration plus XFADE_S of overlap.
    """
    ff = ffmpeg or ffmpeg_bin()
    n_seg = len(cards) - 2
    if n_seg < 1:
        raise ValueError("need at least hook, one segment and end card")
    spans = scene_spans(timeline, n_seg)
    total = spans[-1][1]
    motion = list(kenburns) if kenburns is not None else [card_kind(c) not in STATIC_KINDS for c in cards]
    if len(motion) != len(cards):
        raise ValueError("kenburns must have one flag per card")

    cmd = [ff, "-hide_banner", "-nostats", "-y"]
    lengths = []
    for i, (card, (s0, s1)) in enumerate(zip(cards, spans)):
        length = (s1 - s0) + (XFADE_S if i < len(cards) - 1 else 0.0)
        lengths.append(length)
        cmd += ["-loop", "1", "-framerate", str(FPS), "-t", _f(length), "-i", str(card)]
    wm_idx = len(cards)
    au_idx = wm_idx + 1
    cmd += ["-i", str(watermark), "-i", str(timeline.narration_wav)]

    g: list[str] = []
    for i, length in enumerate(lengths):
        if motion[i]:
            kx, ky = KB_SCALE
            fwd = i % 2 == 0          # alternate pan direction scene to scene
            tx = f"t/{_f(length)}" if fwd else f"(1-t/{_f(length)})"
            g.append(f"[{i}:v]scale={kx}:{ky},crop={W}:{H}:x='({kx}-{W})*{tx}':y='({ky}-{H})*{tx}',"
                     f"setsar=1,fps={FPS},format=yuv420p[v{i}]")
        else:
            g.append(f"[{i}:v]scale={W}:{H},setsar=1,fps={FPS},format=yuv420p[v{i}]")
    prev = "v0"
    for i in range(1, len(cards)):
        out = f"x{i}"
        g.append(f"[{prev}][v{i}]xfade=transition=fade:duration={XFADE_S}:offset={_f(spans[i][0])}[{out}]")
        prev = out
    wb = WATERMARK_BOX
    g.append(f"[{wm_idx}:v]scale={wb.w}:{wb.h},format=rgba[wm]")
    g.append(f"[{prev}][wm]overlay={wb.x}:{wb.y}:format=auto[vw]")
    g.append(f"[vw]ass=filename={_fg_path(ass_path)}:fontsdir={_fg_path(fonts_dir)}:shaping=complex,"
             f"format=yuv420p[vout]")
    g.append(f"[{au_idx}:a]{loudnorm_filter(loudnorm)},aresample=48000,"
             f"aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,apad[aout]")

    cmd += ["-filter_complex", ";".join(g), "-map", "[vout]", "-map", "[aout]",
            "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-preset", "medium",
            "-crf", "19", "-maxrate", "10M", "-bufsize", "20M",
            "-g", "60", "-keyint_min", "60", "-sc_threshold", "0", "-r", str(FPS), "-fps_mode", "cfr",
            "-c:a", "aac", "-ar", "48000", "-b:a", "192k",
            "-movflags", "+faststart", "-t", _f(total), str(out_master)]
    return cmd


def preview_command(master: Path, out: Path, *, crf: int = 26, ffmpeg: str) -> list[str]:
    return [ffmpeg, "-hide_banner", "-nostats", "-y", "-i", str(master), "-vf", "scale=720:1280",
            "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-crf", str(crf),
            "-maxrate", "5M", "-bufsize", "10M", "-c:a", "aac", "-b:a", "128k",
            "-movflags", "+faststart", str(out)]


def cover_command(master: Path, out: Path, *, at_s: float = 0.5, ffmpeg: str) -> list[str]:
    return [ffmpeg, "-hide_banner", "-nostats", "-y", "-ss", _f(at_s), "-i", str(master),
            "-frames:v", "1", "-q:v", "2", "-update", "1", str(out)]


# ── Pipeline ──────────────────────────────────────────────────────────────────


def check_length(timeline: Timeline, max_seconds: float) -> None:
    if timeline.total_s + END_CARD_S > max_seconds:
        raise ScriptTooLong(f"narration {timeline.total_s:.1f} s + end card {END_CARD_S} s "
                            f"> {max_seconds:.0f} s cap; shorten the script")


def _run(runner: Runner, cmd: list[str], what: str, timeout: float = 900) -> subprocess.CompletedProcess:
    try:
        res = runner(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as e:      # the statemachine handles RenderError, not TimeoutExpired
        raise RenderError(f"{what} timed out after {timeout:.0f} s") from e
    except OSError as e:
        raise RenderError(f"{what} could not start: {e}") from e
    if res.returncode != 0:
        tail = "\n".join((res.stderr or "").strip().splitlines()[-15:])
        raise RenderError(f"{what} failed (exit {res.returncode}):\n{tail}")
    return res


def render(script: VideoScript, timeline: Timeline, plan: VideoPlan, work_dir: Path, out_dir: Path, *,
           assets_dir: Path, settings: Settings | None = None, brand: dict | None = None,
           runner: Runner = subprocess.run, ffmpeg: str | None = None) -> RenderOutputs:
    """Cards + ASS + one ffmpeg pass -> master.mp4, preview.mp4 (720p, <= 45 MB) and cover.jpg."""
    settings = settings or get_settings()
    check_length(timeline, settings.max_video_seconds)
    brand = load_brand() if brand is None else brand
    ff = ffmpeg or ffmpeg_bin(runner=runner)
    fonts_dir = assets_dir / "fonts"
    work_dir.mkdir(parents=True, exist_ok=True)
    out_dir.mkdir(parents=True, exist_ok=True)

    cards = build_cards(script, plan, work_dir / "cards", assets_dir, brand=brand)
    end_lines = (brand.get("end_card") or {}).get("lines")
    doc = build_ass(script, timeline, plan, load_fonts(fonts_dir, brand),
                    **({"end_card_lines": end_lines} if end_lines else {}))
    ass_path = write_ass(work_dir / "captions.ass", doc)

    measured = parse_loudnorm_json(
        _run(runner, loudnorm_measure_command(timeline.narration_wav, ffmpeg=ff), "loudnorm pass 1").stderr)
    watermark = assets_dir / str(brand.get("watermark") or "brand/splash-mark.png")
    master = out_dir / "master.mp4"
    part = out_dir / "master.part.mp4"
    _run(runner, render_command(cards, timeline, ass_path, part, fonts_dir=fonts_dir, watermark=watermark,
                                loudnorm=measured, ffmpeg=ff), "render")
    os.replace(part, master)

    preview = out_dir / "preview.mp4"
    for crf in (26, 30, 34):
        _run(runner, preview_command(master, preview, crf=crf, ffmpeg=ff), "preview")
        if not preview.exists() or preview.stat().st_size <= PREVIEW_MAX_BYTES:
            break
    else:
        raise RenderError(f"preview is over {PREVIEW_MAX_BYTES // (1024 * 1024)} MB even at crf 34")
    cover = out_dir / "cover.jpg"
    _run(runner, cover_command(master, cover, ffmpeg=ff), "cover")

    return RenderOutputs(master=master, preview=preview, cover=cover, ass=ass_path,
                         duration_s=scene_spans(timeline, len(script.segments))[-1][1])
