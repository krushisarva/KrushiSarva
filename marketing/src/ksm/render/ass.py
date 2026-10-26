"""ASS subtitle generation: every on-screen word, rendered by libass (HarfBuzz shaping).

Positions come from layout.py; colours are ASS &HAABBGGRR. Text is escaped so script
content can never inject override tags.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Mapping, Sequence

import regex
from PIL import ImageFont

from ..models import Timeline, VideoPlan, VideoScript
from ..voice.timeline import chunk_captions, glen, graphemes, sentence_starts
from .layout import (CAPTION_POS, CENTER_X, END_LINES_POS, HOOK_POS, LABEL_POS, PALETTE, SOURCE_POS, TAG_POS,
                     TEXT_W, UNIT_POS, H, W, bar_layout, data_rows, format_inr, scene_spans)

log = logging.getLogger(__name__)

TAG_TEXT = "AI आवाज"          # AI-voice disclosure, on screen for the whole video (non-negotiable)
UNIT_TEXT = "₹ प्रति क्विंटल"
DEFAULT_END_LINES = ("फॉलो करा", "गावाच्या WhatsApp ग्रुपवर पाठवा", "तुमचा तालुका कमेंट करा")
MAX_LINE_GRAPHEMES = 22


@dataclass(frozen=True)
class FontSpec:
    family: str                   # name-table ID 1, what libass matches
    file: Path | None = None      # used only to estimate widths
    bold: bool = False


DEFAULT_FONTS: dict[str, FontSpec] = {
    "Hook": FontSpec("Baloo 2", bold=True),
    "Caption": FontSpec("Mukta ExtraBold"),
    "Label": FontSpec("Mukta SemiBold"),
    "Number": FontSpec("Mukta ExtraBold"),
    "Tag": FontSpec("Mukta Medium"),
    "Source": FontSpec("Mukta"),
    "EndCard": FontSpec("Mukta ExtraBold"),
}


def load_fonts(fonts_dir: Path, brand: dict) -> dict[str, FontSpec]:
    """Style -> FontSpec from brand.yaml (fonts.styles + fonts.files)."""
    cfg = brand.get("fonts") or {}
    files = cfg.get("files") or {}
    out = dict(DEFAULT_FONTS)
    for style, spec in (cfg.get("styles") or {}).items():
        fname = spec.get("file")
        family = spec.get("family") or (files.get(fname) or {}).get("family")
        if not family:
            continue
        out[style] = FontSpec(family, fonts_dir / fname if fname else None, bool(spec.get("bold")))
    return out


# ── Colours, time, escaping ──────────────────────────────────────────────────


def ass_colour(hex_: str, alpha: int = 0) -> str:
    """'#e0af3b' -> '&H003BAFE0' (AABBGGRR; alpha 0 = opaque)."""
    h = hex_.lstrip("#")
    return f"&H{alpha:02X}{h[4:6]}{h[2:4]}{h[0:2]}".upper()


def _inline_colour(hex_: str) -> str:
    h = hex_.lstrip("#")
    return f"&H{h[4:6]}{h[2:4]}{h[0:2]}&".upper()


def ass_time(t: float) -> str:
    cs = max(0, round(t * 100))
    h, rem = divmod(cs, 360000)
    m, rem = divmod(rem, 6000)
    s, cs = divmod(rem, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


_WJ = "⁠"   # word joiner: breaks '\' + 'N' apart without a visible glyph


def ass_escape(text: str) -> str:
    """Neutralise ASS syntax in script text: braces open override blocks, '\\N' etc. are commands.
    libass prints '\\{' and '\\}' as literal braces and a backslash not followed by N/n/h literally."""
    text = text.replace("\\", "\\" + _WJ).replace("{", "\\{").replace("}", "\\}")
    return " ".join(text.split())   # newlines/tabs -> single spaces


WHITE, GOLD = "#ffffff", PALETTE["gold"]
_NUMBER = regex.compile(r"(?:₹\s?)?\p{Nd}+(?:[,.]\p{Nd}+)*(?:\s?%)?")


def highlight_numbers(escaped: str, base_hex: str = WHITE) -> str:
    """Wrap numerals (₹4,350 / २.५ / 12%) in gold; expects already-escaped text."""
    return _NUMBER.sub(lambda m: f"{{\\1c{_inline_colour(GOLD)}}}{m.group(0)}{{\\1c{_inline_colour(base_hex)}}}",
                       escaped)


def wrap_lines(text: str, max_g: int = MAX_LINE_GRAPHEMES, max_lines: int = 2) -> list[str]:
    """Explicit line breaks (WrapStyle 2 never wraps): honour the author's newlines, otherwise
    split at the word boundary that best balances the lines."""
    given = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if len(given) > max_lines:
        # Never drop words (a lost "नाही" flips the meaning): fold the extra lines into the last one.
        given = [*given[:max_lines - 1], " ".join(given[max_lines - 1:])]
    if len(given) > 1:
        return given
    words = " ".join(given).split()
    if glen(" ".join(words)) <= max_g or len(words) < 2 or max_lines < 2:
        return [" ".join(words)]
    best = min(range(1, len(words)),
               key=lambda i: max(glen(" ".join(words[:i])), glen(" ".join(words[i:]))))
    return [" ".join(words[:best]), " ".join(words[best:])]


@lru_cache(maxsize=32)
def _font(path: str, size: int) -> ImageFont.FreeTypeFont | None:
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return None


def fit_scale(lines: Sequence[str], spec: FontSpec, size: int, max_w: int = TEXT_W) -> int:
    """Percent scale so the widest line fits max_w. Width is ESTIMATED with Pillow's basic
    (unshaped) layout, which over-measures conjuncts — the safe direction. Pillow never draws."""
    if spec.file is None or not spec.file.is_file():
        return 100
    f = _font(str(spec.file), size)
    if f is None:
        return 100
    widest = max((f.getlength(ln) for ln in lines), default=0.0) * (1.08 if spec.bold else 1.0)
    return 100 if widest <= max_w else max(60, int(100 * max_w / widest))


# ── Document ──────────────────────────────────────────────────────────────────

_STYLE_FIELDS = ("Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
                 "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, "
                 "MarginL, MarginR, MarginV, Encoding")

# name: (size, primary, outline colour, back colour, border style, outline, shadow, alignment)
_STYLE_DEFS = {
    "Hook": (92, ass_colour(WHITE), ass_colour(PALETTE["primary"]), ass_colour(PALETTE["ink"], 0x60), 1, 7, 2, 8),
    "Caption": (70, ass_colour(WHITE), ass_colour(PALETTE["ink"]), ass_colour(PALETTE["ink"], 0x80), 1, 5, 0, 2),
    "Label": (54, ass_colour(WHITE), ass_colour(PALETTE["ink"]), ass_colour(PALETTE["ink"], 0x80), 1, 3, 0, 8),
    "Number": (50, ass_colour(GOLD), ass_colour(PALETTE["ink"]), ass_colour(PALETTE["ink"], 0x80), 1, 3, 0, 9),
    "Tag": (34, ass_colour(WHITE), ass_colour(PALETTE["primary"], 0x20), ass_colour(PALETTE["ink"], 0x80), 3, 8, 0, 7),
    "Source": (32, ass_colour(WHITE), ass_colour(PALETTE["ink"]), ass_colour(PALETTE["ink"], 0x80), 1, 2, 0, 2),
    "EndCard": (64, ass_colour(WHITE), ass_colour(PALETTE["primary"]), ass_colour(PALETTE["ink"], 0x80), 1, 5, 0, 8),
}


def _style_line(name: str, spec: FontSpec) -> str:
    size, primary, outline_c, back, border, outline, shadow, align = _STYLE_DEFS[name]
    bold = -1 if spec.bold else 0
    family = spec.family.replace(",", " ")
    return (f"Style: {name},{family},{size},{primary},&H000000FF,{outline_c},{back},{bold},0,0,0,100,100,0,0,"
            f"{border},{outline},{shadow},{align},0,0,0,1")


@dataclass
class _Event:
    start: float
    end: float
    style: str
    text: str           # already escaped / tagged
    layer: int = 0

    def line(self) -> str:
        return f"Dialogue: {self.layer},{ass_time(self.start)},{ass_time(self.end)},{self.style},,0,0,0,,{self.text}"


def _pos(an: int, xy: tuple[int, int], scale: int = 100) -> str:
    sc = f"\\fscx{scale}\\fscy{scale}" if scale != 100 else ""
    return f"{{\\an{an}\\pos({xy[0]},{xy[1]}){sc}}}"


def _as_specs(fonts: Mapping[str, FontSpec | str] | None) -> dict[str, FontSpec]:
    out = dict(DEFAULT_FONTS)
    for k, v in (fonts or {}).items():
        out[k] = FontSpec(v) if isinstance(v, str) else v
    return out


def build_ass(script: VideoScript, timeline: Timeline, plan: VideoPlan, fonts: Mapping[str, FontSpec | str] | None,
              *, end_card_lines: Sequence[str] = DEFAULT_END_LINES) -> str:
    """The complete .ass document for one video. `fonts` maps style name -> FontSpec (or family)."""
    specs = _as_specs(fonts)
    n_seg = len(script.segments)
    spans = scene_spans(timeline, n_seg)
    total = spans[-1][1]
    ev: list[_Event] = []

    # Whole video: AI-voice tag and source line.
    ev.append(_Event(0, total, "Tag", _pos(7, TAG_POS) + ass_escape(TAG_TEXT), layer=2))
    if script.sources_onscreen_mr.strip():
        src = ass_escape(script.sources_onscreen_mr)
        ev.append(_Event(0, total, "Source", _pos(2, SOURCE_POS, fit_scale([src], specs["Source"], 32)) + src, layer=1))

    # Scene 0: hook.
    hook = [ass_escape(x) for x in wrap_lines(script.hook.onscreen_mr)]
    if hook:
        ev.append(_Event(spans[0][0], spans[0][1], "Hook",
                         _pos(8, HOOK_POS, fit_scale(hook, specs["Hook"], 92)) + "{\\fad(150,0)}"
                         + "\\N".join(highlight_numbers(h) for h in hook), layer=1))

    # Segments: label + data-card text pinned to the card geometry.
    for i, seg in enumerate(script.segments):
        s0, s1 = spans[i + 1]
        label = [ass_escape(x) for x in wrap_lines(seg.onscreen_mr)]
        if label and seg.visual.kind != "end_card":
            ev.append(_Event(s0, s1, "Label", _pos(8, LABEL_POS, fit_scale(label, specs["Label"], 54))
                             + "\\N".join(label), layer=1))
        rows = data_rows(seg.visual.kind, plan.payload, seg.visual.data_ref)
        geoms = bar_layout(rows)
        for g in geoms:
            name = ass_escape(g.row.label)
            ev.append(_Event(s0, s1, "Label", _pos(7, g.label_pos, fit_scale([name], specs["Label"], g.font_size, 500))
                             + f"{{\\fs{g.font_size}}}" + name, layer=1))
            ev.append(_Event(s0, s1, "Number", _pos(9, g.value_pos) + f"{{\\fs{g.font_size}}}"
                             + ass_escape(format_inr(g.row.value)), layer=1))
        if geoms:
            ev.append(_Event(s0, s1, "Source", _pos(9, UNIT_POS)
                             + ass_escape(UNIT_TEXT), layer=1))

    # End card.
    e0, e1 = spans[-1]
    for k, (line, xy) in enumerate(zip(end_card_lines, END_LINES_POS)):
        size = 64 if k == 0 else 48
        txt = ass_escape(line)
        ev.append(_Event(e0, e1, "EndCard", _pos(8, xy, fit_scale([txt], specs["EndCard"], size))
                         + f"{{\\fs{size}\\fad(200,0)}}" + txt, layer=1))

    # Captions: every sentence, chunked and timed by grapheme share.
    for s, start in zip(timeline.sentences, sentence_starts(timeline)):
        for c0, c1, text in chunk_captions(s.text, s.duration_s, start):
            esc = ass_escape(text)
            ev.append(_Event(c0, c1, "Caption", _pos(2, CAPTION_POS, fit_scale([esc], specs["Caption"], 70))
                             + highlight_numbers(esc), layer=3))

    head = [
        "[Script Info]",
        "; KrushiSarva marketing autopilot",
        "ScriptType: v4.00+",
        f"PlayResX: {W}",
        f"PlayResY: {H}",
        "WrapStyle: 2",
        "ScaledBorderAndShadow: yes",
        "YCbCr Matrix: TV.709",
        "",
        "[V4+ Styles]",
        f"Format: {_STYLE_FIELDS}",
        *(_style_line(name, specs[name]) for name in _STYLE_DEFS),
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    body = [e.line() for e in sorted(ev, key=lambda e: (e.start, e.layer))]
    return "\n".join(head + body) + "\n"


def write_ass(path: Path, doc: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(doc, encoding="utf-8")
    return path


__all__ = ["FontSpec", "DEFAULT_FONTS", "TAG_TEXT", "load_fonts", "build_ass", "write_ass", "ass_escape",
           "ass_colour", "ass_time", "wrap_lines", "highlight_numbers", "fit_scale", "CENTER_X", "graphemes"]
