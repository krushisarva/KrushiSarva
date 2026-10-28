import subprocess
from dataclasses import replace
from pathlib import Path

import pytest

from _media_fixtures import REPO_MARKETING, sample_brand, sample_plan, sample_script, sample_timeline
from ksm.config import settings_from_file
from ksm.render import ffmpeg as F
from ksm.render.layout import END_CARD_S, XFADE_S, scene_spans

FF = "/fake/ffmpeg"
MEASURED = ('{"input_i" : "-20.10", "input_tp" : "-6.20", "input_lra" : "1.30", "input_thresh" : "-30.40", '
            '"output_i" : "-14.0", "normalization_type" : "linear", "target_offset" : "0.10"}')


def _cards(tmp_path, kinds=("title", "mandi_bars", "msp_compare", "illustration", "end_card")):
    return [tmp_path / f"{i:02d}-{k}.png" for i, k in enumerate(kinds)]


def _settings(**over):
    s = settings_from_file(REPO_MARKETING / "config" / "settings.yaml")
    return replace(s, **over)


def test_parse_buildconf():
    text = "  configuration:\n    --prefix=/x\n    --enable-libass\n    --enable-libharfbuzz\n    --enable-gpl\n"
    assert {"libass", "libharfbuzz", "gpl"} <= F.parse_buildconf(text)


def test_ffmpeg_bin_requires_libass(monkeypatch, tmp_path):
    plain, full = tmp_path / "plain", tmp_path / "full"
    for p in (plain, full):
        p.write_text("#!/bin/sh\n")
        p.chmod(0o755)
    conf = {str(plain): "--enable-libfreetype --enable-libharfbuzz",
            str(full): "--enable-libass --enable-libfreetype --enable-libharfbuzz"}
    run = lambda cmd, **kw: subprocess.CompletedProcess(cmd, 0, conf[cmd[0]], "")  # noqa: E731
    monkeypatch.setattr(F, "_candidates", lambda: [str(plain), str(full)])
    assert F.ffmpeg_bin(runner=run) == str(full)
    monkeypatch.setattr(F, "_candidates", lambda: [str(plain), "/does/not/exist"])
    with pytest.raises(F.FfmpegMissing, match="brew install ffmpeg-full") as e:
        F.ffmpeg_bin(runner=run)
    assert "missing libass" in str(e.value)


def test_render_command_structure(tmp_path):
    script = sample_script()
    tl = sample_timeline(tmp_path, script)
    cards = _cards(tmp_path)
    ass, fonts = tmp_path / "work dir" / "captions.ass", tmp_path / "fonts"
    cmd = F.render_command(cards, tl, ass, tmp_path / "m.mp4", fonts_dir=fonts, watermark=tmp_path / "wm.png",
                           loudnorm=__import__("json").loads(MEASURED), ffmpeg=FF)
    spans = scene_spans(tl, len(script.segments))
    total = spans[-1][1]

    # one looped input per card, length = scene + xfade overlap (last scene: no overlap)
    t_args = [float(cmd[i + 1]) for i, a in enumerate(cmd) if a == "-t"]
    for (s0, s1), t, last in zip(spans, t_args, [False] * 4 + [True]):
        assert t == pytest.approx((s1 - s0) + (0 if last else XFADE_S), abs=1e-3)
    assert t_args[-1] == pytest.approx(total, abs=1e-3)          # output -t
    assert cmd.count("-loop") == len(cards)

    g = cmd[cmd.index("-filter_complex") + 1]
    assert g.count("xfade=transition=fade") == len(cards) - 1
    for i in range(1, len(cards)):
        assert f"offset={spans[i][0]:.3f}" in g
    # Ken Burns only on scenes without pinned text
    assert "[0:v]scale=1188:2112,crop=1080:1920" in g and "[3:v]scale=1188:2112" in g
    assert "[1:v]scale=1080:1920," in g and "[4:v]scale=1080:1920," in g
    assert "overlay=740:390" in g and "scale=140:140" in g
    assert f"ass=filename='{ass}':fontsdir='{fonts}':shaping=complex" in g
    assert "loudnorm=I=-14.0:TP=-1.5:LRA=11.0:measured_I=-20.10:measured_TP=-6.20" in g and "linear=true" in g
    assert "aresample=48000" in g

    def opt(name):
        return cmd[cmd.index(name) + 1]
    assert (opt("-c:v"), opt("-profile:v"), opt("-pix_fmt"), opt("-crf")) == ("libx264", "high", "yuv420p", "19")
    assert (opt("-maxrate"), opt("-bufsize"), opt("-g"), opt("-keyint_min"), opt("-sc_threshold"), opt("-r")) == \
        ("10M", "20M", "60", "60", "0", "30")
    assert (opt("-c:a"), opt("-ar"), opt("-b:a"), opt("-movflags")) == ("aac", "48000", "192k", "+faststart")
    assert cmd[-1] == str(tmp_path / "m.mp4")


def test_render_command_rejects_unsafe_paths(tmp_path):
    tl = sample_timeline(tmp_path)
    with pytest.raises(ValueError, match="filtergraph"):
        F.render_command(_cards(tmp_path), tl, tmp_path / "a:b.ass", tmp_path / "m.mp4",
                         fonts_dir=tmp_path, watermark=tmp_path / "w.png", ffmpeg=FF)


def test_parse_loudnorm():
    m = F.parse_loudnorm_json("[Parsed_loudnorm_0 @ 0x1]\n" + MEASURED + "\n")
    assert m["input_i"] == "-20.10" and m["target_offset"] == "0.10"
    with pytest.raises(F.RenderError):
        F.parse_loudnorm_json("no json here")


def test_script_too_long(tmp_path):
    tl = sample_timeline(tmp_path, per_char=0.25)        # ~70 s of narration
    with pytest.raises(F.ScriptTooLong):
        F.render(sample_script(), tl, sample_plan(), tmp_path / "w", tmp_path / "o", assets_dir=tmp_path,
                 settings=_settings(), brand=sample_brand(), ffmpeg=FF, runner=lambda *a, **k: None)
    F.check_length(tl, tl.total_s + END_CARD_S)          # exactly at the cap is allowed


def test_render_pipeline_with_fake_runner(tmp_path):
    calls: list[list[str]] = []

    def run(cmd, **kw):
        calls.append(cmd)
        out = Path(cmd[-1]) if cmd[-1] != "-" else None
        if out is not None:
            out.write_bytes(b"x")
        return subprocess.CompletedProcess(cmd, 0, "", MEASURED if "print_format=json" in " ".join(cmd) else "")

    script = sample_script()
    tl = sample_timeline(tmp_path, script)
    assets = REPO_MARKETING / "assets"
    res = F.render(script, tl, sample_plan(), tmp_path / "work", tmp_path / "out", assets_dir=assets,
                   settings=_settings(), brand=sample_brand(), ffmpeg=FF, runner=run)
    assert [Path(c[-1]).name if c[-1] != "-" else "-" for c in calls] == \
        ["-", "master.part.mp4", "preview.mp4", "cover.jpg"]
    assert res.master.name == "master.mp4" and res.master.exists() and not (tmp_path / "out/master.part.mp4").exists()
    assert res.ass.read_text(encoding="utf-8").startswith("[Script Info]")
    assert len(list((tmp_path / "work" / "cards").glob("*.png"))) == len(script.segments) + 2
    assert res.duration_s == pytest.approx(scene_spans(tl, len(script.segments))[-1][1])
    assert "scale=720:1280" in calls[2] and "26" in calls[2]
    assert calls[3][calls[3].index("-ss") + 1] == "0.500"


def test_render_error_surfaces_stderr(tmp_path):
    def run(cmd, **kw):
        return subprocess.CompletedProcess(cmd, 1, "", "line1\nNo such filter: 'ass'\n")
    tl = sample_timeline(tmp_path)
    with pytest.raises(F.RenderError, match="No such filter"):
        F.render(sample_script(), tl, sample_plan(), tmp_path / "w", tmp_path / "o",
                 assets_dir=REPO_MARKETING / "assets", settings=_settings(), brand=sample_brand(), ffmpeg=FF, runner=run)


def test_subprocess_timeout_becomes_render_error(tmp_path):
    def run(cmd, **kw):
        raise subprocess.TimeoutExpired(cmd, kw.get("timeout"))
    tl = sample_timeline(tmp_path)
    with pytest.raises(F.RenderError, match="timed out"):
        F.render(sample_script(), tl, sample_plan(), tmp_path / "w", tmp_path / "o",
                 assets_dir=REPO_MARKETING / "assets", settings=_settings(), brand=sample_brand(), ffmpeg=FF, runner=run)
