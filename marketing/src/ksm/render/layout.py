"""Shared geometry for the 1080x1920 frame.

Pillow (cards.py) draws shapes and ASS (ass.py) draws text from the SAME numbers here,
so a bar and its value can never drift apart. Every text region stays inside SAFE,
which clears the YouTube Shorts / Reels overlays (top ~380 px, bottom ~390+ px, right ~200 px).
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..config import load_yaml
from ..models import Timeline

W, H = 1080, 1920
SAFE = dict(x0=70, x1=880, y0=380, y1=1250)
CENTER_X = (SAFE["x0"] + SAFE["x1"]) // 2          # 475: text is centred in the safe zone, not the frame

PALETTE = {
    "primary": "#005f21", "glow": "#31aa40", "accent": "#c9f2c0", "secondary": "#e3f5da",
    "ink": "#06210d", "background": "#f9fdf6", "gold": "#e0af3b",
}

# Timing shared by ass.py and ffmpeg.py.
XFADE_S = 0.25            # cross-fade between scenes
END_CARD_S = 2.5          # end card shows at least this long ...
END_SILENCE_MAX_S = 0.7   # ... but never adds more than this much silence after the CTA. QA fails on silence
                          # > 1.2 s, and the TTS clip's own trailing silence adds to this, so keep ~0.5 s margin.
TAIL_S = 0.4              # breathing room after the last word


@dataclass(frozen=True)
class Box:
    x: int
    y: int
    w: int
    h: int

    @property
    def x1(self) -> int:
        return self.x + self.w

    @property
    def y1(self) -> int:
        return self.y + self.h

    def inside(self, other: "Box") -> bool:
        return self.x >= other.x and self.y >= other.y and self.x1 <= other.x1 and self.y1 <= other.y1

    def overlaps(self, other: "Box") -> bool:
        return self.x < other.x1 and other.x < self.x1 and self.y < other.y1 and other.y < self.y1


SAFE_BOX = Box(SAFE["x0"], SAFE["y0"], SAFE["x1"] - SAFE["x0"], SAFE["y1"] - SAFE["y0"])
TEXT_W = SAFE_BOX.w                                  # 810 px max line width

# Brand row (whole video): AI-voice tag top-left, logo watermark top-right.
TAG_POS = (70, 390)                                  # ASS \an7 (top-left)
TAG_BOX = Box(70, 390, 260, 56)
WATERMARK_BOX = Box(740, 390, 140, 140)
# Headline area below the brand row: the hook (scene 0) or the segment label (other scenes).
# The hook sits at y=545 rather than 420 so its 2 lines never run under the watermark (390-530).
HOOK_POS = (CENTER_X, 545)                           # \an8 (top-centre); 2 lines of 92 px
HOOK_BOX = Box(70, 545, TEXT_W, 240)
LABEL_POS = (CENTER_X, 560)                          # \an8; up to 2 lines of 54 px
LABEL_BOX = Box(70, 560, TEXT_W, 140)
CHART_BOX = Box(70, 710, TEXT_W, 320)                # data bars + their labels/values
UNIT_POS = (SAFE["x1"], 1036)                        # \an9 unit line under the bars ("₹ प्रति क्विंटल")
UNIT_BOX = Box(70, 1036, TEXT_W, 34)
CAPTION_POS = (CENTER_X, 1180)                       # \an2 (bottom-centre), one line of 70 px
CAPTION_BOX = Box(70, 1090, TEXT_W, 90)
SOURCE_POS = (CENTER_X, 1250)                        # \an2; 32 px line centred near y=1230
SOURCE_BOX = Box(70, 1210, TEXT_W, 40)
CAPTION_BAND = Box(0, 1070, W, 200)                  # translucent band cards.py paints behind captions
# End card: logo, then three short lines.
END_LOGO_BOX = Box(CENTER_X - 135, 560, 270, 270)
END_LINES_POS = [(CENTER_X, 860), (CENTER_X, 960), (CENTER_X, 1030)]   # \an8
END_TEXT_BOX = Box(70, 860, TEXT_W, 230)
ILLUSTRATION_BOX = Box(60, 700, 960, 720)            # brand master image, fitted (may sit under the band)

TEXT_REGIONS = {
    "tag": TAG_BOX, "hook": HOOK_BOX, "label": LABEL_BOX, "chart": CHART_BOX,
    "unit": UNIT_BOX, "caption": CAPTION_BOX, "source": SOURCE_BOX, "end_text": END_TEXT_BOX,
}

# Visual kinds whose ASS text is pinned to card geometry: no Ken Burns motion on these.
STATIC_KINDS = frozenset({"mandi_bars", "msp_compare", "step_card", "checklist", "end_card"})
DATA_KINDS = frozenset({"mandi_bars", "msp_compare"})
MAX_BARS = 4


# ── Scenes ────────────────────────────────────────────────────────────────────


def scene_spans(timeline: Timeline, n_segments: int) -> list[tuple[float, float]]:
    """(start, end) per scene: [hook, segment 0..n-1, end card (CTA)].

    A scene runs from its first sentence to the next scene's first sentence, so the
    inter-sentence gap belongs to the earlier scene. The end card lasts END_CARD_S
    unless that would leave more than END_SILENCE_MAX_S of silence.
    """
    starts: dict[int, float] = {}
    t = 0.0
    for s in timeline.sentences:
        starts.setdefault(s.segment_index, t)
        t += s.duration_s + timeline.gap_s
    order = [-1, *range(n_segments), n_segments]
    missing = [i for i in order if i not in starts]
    if missing:
        raise ValueError(f"scenes without narration: {missing}")
    begins = [starts[i] for i in order]
    begins[0] = 0.0
    narration_end = timeline.total_s
    last_end = max(narration_end + TAIL_S,
                   min(begins[-1] + END_CARD_S, narration_end + END_SILENCE_MAX_S))
    ends = [*begins[1:], last_end]
    return list(zip(begins, ends))


def video_duration(timeline: Timeline, n_segments: int) -> float:
    return scene_spans(timeline, n_segments)[-1][1]


# ── Data cards ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class DataRow:
    label: str
    value: float
    highlight: bool = False          # e.g. the MSP bar (gold)


@dataclass(frozen=True)
class BarGeom:
    row: DataRow
    track: Box                       # full-width background track
    bar: Box                         # filled part, length proportional to value (zero baseline)
    label_pos: tuple[int, int]       # ASS \an7 (top-left)
    value_pos: tuple[int, int]       # ASS \an9 (top-right)
    font_size: int


_REF_TOKEN = re.compile(r"([^.\[\]]+)|\[(\d+)\]")


def resolve_ref(payload: Any, ref: str | None) -> Any:
    """'commodities[0].markets' -> payload['commodities'][0]['markets']; None if absent."""
    if not ref:
        return None
    cur = payload
    for key, idx in _REF_TOKEN.findall(ref):
        try:
            cur = cur[int(idx)] if idx else cur[key]
        except (KeyError, IndexError, TypeError, ValueError):
            return None
    return cur


def _num(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) and f > 0 else None


def data_rows(kind: str, payload: dict, data_ref: str | None) -> list[DataRow]:
    """Rows for a data card, straight from the payload (never from the script text)."""
    item = resolve_ref(payload, data_ref)
    if not isinstance(item, dict):
        return []
    if kind == "mandi_bars":
        rows = []
        for m in item.get("markets") or []:
            v = _num(m.get("modal"))
            name = m.get("market_mr") or m.get("market")
            if v and name:
                rows.append(DataRow(str(name), v))
        rows.sort(key=lambda r: r.value, reverse=True)
        return rows[:MAX_BARS]
    if kind == "msp_compare":
        market, msp = _num(item.get("median_modal")), _num(item.get("msp"))
        if not (market and msp):
            return []
        return [DataRow("बाजारभाव", market), DataRow(str(item.get("msp_label") or "हमीभाव"), msp, highlight=True)]
    return []


def bar_layout(rows: list[DataRow], box: Box = CHART_BOX) -> list[BarGeom]:
    if not rows:
        return []
    n = len(rows)
    row_h = box.h // n
    font = 40 if n > 2 else 50
    bar_h = max(22, min(56, int(row_h * 0.3)))
    vmax = max(r.value for r in rows)
    out = []
    for i, r in enumerate(rows):
        y = box.y + i * row_h
        bar_y = y + font + 10
        track = Box(box.x, bar_y, box.w, bar_h)
        bar = Box(box.x, bar_y, max(bar_h, round(box.w * r.value / vmax)), bar_h)
        out.append(BarGeom(r, track, bar, (box.x, y), (box.x1, y), font))
    return out


def format_inr(value: float) -> str:
    """4350 -> '₹4,350'; 125000 -> '₹1,25,000' (Indian digit grouping)."""
    v = round(value, 2)
    whole = int(v)
    frac = f"{v - whole:.2f}"[1:] if v != whole else ""
    s = str(whole)
    if len(s) > 3:
        head, tail = s[:-3], s[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        s = ",".join([*groups, tail])
    return f"₹{s}{frac}"


# ── Brand config ──────────────────────────────────────────────────────────────


def load_brand(config_dir: Path | None = None) -> dict:
    return load_yaml("brand.yaml", config_dir) or {}


def asset_allowed(asset_id: str | None, brand: dict) -> bool:
    """Illustration allow-list: allowed prefix AND no forbidden token (SYMPTOM/SCOUT/SEV) AND not denied."""
    if not asset_id or "/" in asset_id or "\\" in asset_id or ".." in asset_id:
        return False
    ill = brand.get("illustrations") or {}
    prefixes = tuple(ill.get("allowed_prefixes") or ())
    forbidden = [t.upper() for t in (ill.get("forbidden_tokens") or ("SYMPTOM", "SCOUT", "SEV"))]
    denied = {d.upper() for d in (ill.get("denied_ids") or ())}
    up = asset_id.upper()
    if any(tok in up for tok in forbidden) or up in denied:
        return False
    return bool(prefixes) and asset_id.startswith(prefixes)
