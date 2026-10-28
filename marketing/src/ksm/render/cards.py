"""Scene backgrounds (Pillow). TEXT-FREE by rule.

Pillow here has no raqm, so any Devanagari it drew would be silently mis-shaped; all
text is drawn later by libass at positions from layout.py. Cards are 1080x1920 RGB PNGs,
one per scene: [hook, segment 0..n-1, end card].
"""
from __future__ import annotations

import logging
from pathlib import Path

from PIL import Image, ImageDraw

from ..models import VideoPlan, VideoScript
from .layout import (CAPTION_BAND, CHART_BOX, END_LOGO_BOX, ILLUSTRATION_BOX, LABEL_BOX, PALETTE, H, W, Box,
                     asset_allowed, bar_layout, data_rows, load_brand)

log = logging.getLogger(__name__)


def _rgb(hex_: str) -> tuple[int, int, int]:
    h = hex_.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def _gradient(top: str, bottom: str) -> Image.Image:
    a, b = _rgb(top), _rgb(bottom)
    col = Image.new("RGB", (1, H))
    for y in range(H):
        t = y / (H - 1)
        col.putpixel((0, y), tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3)))
    return col.resize((W, H))


def _overlay(img: Image.Image, box: Box, fill: tuple[int, int, int, int], radius: int = 0) -> None:
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(layer).rounded_rectangle((box.x, box.y, box.x1, box.y1), radius=radius, fill=fill)
    img.alpha_composite(layer)


def _paste_fit(img: Image.Image, src: Path, box: Box) -> bool:
    try:
        art = Image.open(src).convert("RGBA")
    except OSError as e:
        log.warning("cannot open %s: %s", src, e)
        return False
    art.thumbnail((box.w, box.h), Image.Resampling.LANCZOS)
    x = box.x + (box.w - art.width) // 2
    y = box.y + (box.h - art.height) // 2
    img.alpha_composite(art, (x, y))
    return True


def _decor(img: Image.Image, colour: str, alpha: int) -> None:
    """Soft field-row arcs in the lower third: brand texture, no meaning."""
    r, g, b = _rgb(colour)
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for i in range(6):
        y = 1330 + i * 70
        d.arc((-300, y, W + 300, y + 900), 200, 340, fill=(r, g, b, alpha), width=18)
    img.alpha_composite(layer)


def _base(dark: bool) -> Image.Image:
    p = PALETTE
    img = (_gradient(p["primary"], p["ink"]) if dark else _gradient(p["secondary"], p["accent"])).convert("RGBA")
    _decor(img, p["glow"] if dark else p["primary"], 40 if dark else 28)
    return img


def _caption_band(img: Image.Image) -> None:
    _overlay(img, CAPTION_BAND, (*_rgb(PALETTE["ink"]), 150))


def illustration_path(asset_id: str | None, assets_dir: Path, brand: dict) -> Path | None:
    """The master image for asset_id, or None if it is not allow-listed or not installed."""
    if not asset_id:
        return None
    if not asset_allowed(asset_id, brand):
        log.warning("illustration %r is not on the allow-list; using a plain card", asset_id)
        return None
    p = assets_dir / "illustrations" / f"{asset_id}.png"
    return p if p.is_file() else None


def _illustration_card(asset: Path | None) -> Image.Image:
    img = _base(dark=asset is None)
    if asset is not None:
        _paste_fit(img, asset, ILLUSTRATION_BOX)
    return img


def _data_card(kind: str, plan: VideoPlan, data_ref: str | None) -> Image.Image:
    p = PALETTE
    img = _base(dark=True)
    _overlay(img, Box(CHART_BOX.x - 30, LABEL_BOX.y - 30, CHART_BOX.w + 60, CHART_BOX.y1 - LABEL_BOX.y + 60),
             (*_rgb(p["ink"]), 120), radius=36)
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for g in bar_layout(data_rows(kind, plan.payload, data_ref)):
        r = g.track.h // 2
        d.rounded_rectangle((g.track.x, g.track.y, g.track.x1, g.track.y1), radius=r,
                            fill=(*_rgb(p["accent"]), 46))
        d.rounded_rectangle((g.bar.x, g.bar.y, g.bar.x1, g.bar.y1), radius=r,
                            fill=(*_rgb(p["gold"] if g.row.highlight else p["glow"]), 255))
    img.alpha_composite(layer)
    return img


def _panel_card(asset: Path | None) -> Image.Image:
    """step_card / checklist: a calm panel for the segment label, optional small illustration."""
    img = _base(dark=True)
    _overlay(img, Box(40, LABEL_BOX.y - 30, W - 80, 560), (*_rgb(PALETTE["secondary"]), 36), radius=40)
    if asset is not None:
        _paste_fit(img, asset, Box(240, 720, 600, 340))
    return img


def _end_card(assets_dir: Path, brand: dict) -> Image.Image:
    img = _base(dark=True)
    logo = assets_dir / str(brand.get("watermark") or "brand/splash-mark.png")
    if logo.is_file():
        _paste_fit(img, logo, END_LOGO_BOX)
    return img


def build_cards(script: VideoScript, plan: VideoPlan, out_dir: Path, assets_dir: Path,
                *, brand: dict | None = None) -> list[Path]:
    """One text-free 1080x1920 PNG per scene, named NN-<kind>.png (ffmpeg.py reads the kind
    from the name to decide whether the scene may move)."""
    brand = load_brand() if brand is None else brand
    out_dir.mkdir(parents=True, exist_ok=True)
    first_asset = next((s.visual.asset_id for s in script.segments if s.visual.kind == "illustration"), None)

    scenes: list[tuple[str, Image.Image]] = [("title", _illustration_card(illustration_path(first_asset, assets_dir, brand)))]
    for seg in script.segments:
        v = seg.visual
        if v.kind in ("mandi_bars", "msp_compare"):
            scenes.append((v.kind, _data_card(v.kind, plan, v.data_ref)))
        elif v.kind in ("step_card", "checklist"):
            scenes.append((v.kind, _panel_card(illustration_path(v.asset_id, assets_dir, brand))))
        elif v.kind == "end_card":
            scenes.append(("end_card", _end_card(assets_dir, brand)))
        else:   # title, illustration, broll (Pexels B-roll arrives in M3; until then a brand card)
            kind = "illustration" if v.kind == "broll" else v.kind
            scenes.append((kind, _illustration_card(illustration_path(v.asset_id, assets_dir, brand))))
    scenes.append(("end_card", _end_card(assets_dir, brand)))

    paths = []
    for i, (kind, img) in enumerate(scenes):
        _caption_band(img)
        p = out_dir / f"{i:02d}-{kind}.png"
        img.convert("RGB").save(p, optimize=False)
        paths.append(p)
    return paths


def card_kind(path: Path) -> str:
    """'03-mandi_bars.png' -> 'mandi_bars'."""
    stem = path.stem
    return stem.split("-", 1)[1] if "-" in stem else stem
