"""Golden render: conjunct-heavy Marathi through the real ffmpeg-full/libass path.

Needs ffmpeg-full (brew install ffmpeg-full); skipped otherwise. Reference frames live in
tests/golden/ and are approved by a human once: on the first run the candidate frames are
written next to them as *.candidate.png for review.
"""
import subprocess
from dataclasses import replace

import pytest
from PIL import Image, ImageChops, ImageStat

from _media_fixtures import REPO_MARKETING, FakeTTS, sample_brand, sample_plan, sample_script
from ksm.config import settings_from_file
from ksm.models import Hook, Segment, Visual
from ksm.render import ffmpeg as F
from ksm.render.qa import probe
from ksm.voice.timeline import synthesize

pytestmark = pytest.mark.render
GOLDEN = REPO_MARKETING / "tests" / "golden"
FRAMES = {"hook": 1.0, "bars": 5.0, "end": None}      # None = 1 s before the end


def _ffmpeg() -> str:
    try:
        return F.ffmpeg_bin()
    except F.FfmpegMissing as e:
        pytest.skip(str(e))


def _script():
    return sample_script(
        hook=Hook(voice_mr="द्राक्ष क्षेत्रात आज श्रीमंत भाव मिळाला, ₹४,३५० प्रति क्विंटल.",
                  onscreen_mr="द्राक्ष क्षेत्र ₹४,३५० प्रति क्विंटल"),
        segments=[
            Segment(voice_mr="कृषी बाजार समितीत सोयाबीनचे भाव पाहूया. लातूर सर्वात पुढे आहे.",
                    onscreen_mr="कृषी क्षेत्रातील भाव", visual=Visual(kind="mandi_bars", data_ref="commodities[0]")),
            Segment(voice_mr="सरासरी भाव ₹४,२१० प्रति क्विंटल, तर हमीभाव ₹५,३२८ आहे.",
                    onscreen_mr="श्रीमंत द्राक्ष क्षेत्र", visual=Visual(kind="msp_compare", data_ref="commodities[0]")),
            Segment(voice_mr="विक्रीपूर्वी जवळच्या कृषी उत्पन्न बाजार समितीचे भाव तपासा.",
                    onscreen_mr="क्षेत्र · द्राक्ष · कृषी", visual=Visual(kind="illustration", asset_id="CROP-Grapes")),
        ])


def test_golden_conjunct_render(tmp_path):
    ff = _ffmpeg()
    script = _script()
    tl = synthesize(script, FakeTTS(per_char=0.055), tmp_path / "voice")
    settings = replace(settings_from_file(REPO_MARKETING / "config" / "settings.yaml"), max_video_seconds=58)
    out = F.render(script, tl, sample_plan(), tmp_path / "work", tmp_path / "out",
                   assets_dir=REPO_MARKETING / "assets", settings=settings, brand=sample_brand(), ffmpeg=ff)
    assert 15 <= out.duration_s <= 58

    report = probe(out.master, ffmpeg=ff)
    assert report.ok, report.problems
    assert out.preview.stat().st_size <= F.PREVIEW_MAX_BYTES and out.cover.stat().st_size > 0

    GOLDEN.mkdir(exist_ok=True)
    missing = []
    for name, t in FRAMES.items():
        at = out.duration_s - 1.0 if t is None else t
        frame = tmp_path / f"{name}.png"
        subprocess.run([ff, "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{at:.2f}", "-i", str(out.master),
                        "-frames:v", "1", str(frame)], check=True)
        ref = GOLDEN / f"render_conjuncts_{name}.png"
        if not ref.exists():
            Image.open(frame).save(GOLDEN / f"render_conjuncts_{name}.candidate.png")
            missing.append(ref.name)
            continue
        with Image.open(frame) as a, Image.open(ref) as b:
            diff = ImageStat.Stat(ImageChops.difference(a.convert("RGB"), b.convert("RGB"))).mean
        assert max(diff) < 4.0, f"{name} frame drifted from the approved reference ({diff})"
    if missing:
        pytest.skip(f"no approved reference yet for {missing}; review tests/golden/*.candidate.png and rename")
