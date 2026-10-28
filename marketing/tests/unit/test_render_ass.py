import re

import pytest

from _media_fixtures import REPO_MARKETING, sample_brand, sample_plan, sample_script, sample_timeline
from ksm.models import Hook
from ksm.render.ass import (FontSpec, ass_colour, ass_escape, ass_time, build_ass, fit_scale, highlight_numbers,
                            load_fonts, wrap_lines)
from ksm.render.layout import CAPTION_POS, TAG_POS


@pytest.fixture
def doc(tmp_path):
    script = sample_script()
    return build_ass(script, sample_timeline(tmp_path, script), sample_plan(), None)


def _events(doc):
    return [l for l in doc.splitlines() if l.startswith("Dialogue:")]


def test_header_and_styles(doc):
    head = doc.split("[Events]")[0]
    for line in ("PlayResX: 1080", "PlayResY: 1920", "WrapStyle: 2", "ScaledBorderAndShadow: yes"):
        assert line in head
    styles = {l.split(",")[0][len("Style: "):]: l.split(",") for l in head.splitlines() if l.startswith("Style:")}
    assert set(styles) == {"Hook", "Caption", "Label", "Number", "Tag", "Source", "EndCard"}
    assert styles["Hook"][1:3] == ["Baloo 2", "92"] and styles["Hook"][7] == "-1"
    assert styles["Hook"][5] == "&H00215F00"                    # green outline (#005f21 as BGR)
    assert styles["Caption"][1:4] == ["Mukta ExtraBold", "70", "&H00FFFFFF"] and styles["Caption"][16] == "5"
    assert styles["Label"][1:3] == ["Mukta SemiBold", "54"]
    assert styles["Number"][3] == "&H003BAFE0"                  # gold #e0af3b
    assert styles["Tag"][1:3] == ["Mukta Medium", "34"] and styles["Tag"][15] == "3"
    assert styles["Source"][1:3] == ["Mukta", "32"]


def test_ai_voice_tag_covers_whole_video(doc):
    ev = _events(doc)
    tag = [e for e in ev if ",Tag," in e]
    assert len(tag) == 1 and "AI आवाज" in tag[0]
    assert tag[0].split(",")[1] == "0:00:00.00"
    ends = [e.split(",")[2] for e in ev]
    assert tag[0].split(",")[2] == max(ends)
    assert f"\\pos({TAG_POS[0]},{TAG_POS[1]})" in tag[0]


def test_captions_bottom_anchored_and_numbers_gold(doc):
    caps = [e for e in _events(doc) if ",Caption," in e]
    assert len(caps) >= 6
    assert all(f"{{\\an2\\pos({CAPTION_POS[0]},{CAPTION_POS[1]})" in c for c in caps)
    assert any("{\\1c&H3BAFE0&}₹४,३५०{\\1c&HFFFFFF&}" in c for c in caps)


def test_data_card_numbers_from_payload(doc):
    nums = [e for e in _events(doc) if ",Number," in e]
    texts = [e.rsplit("}", 1)[1] for e in nums]
    assert texts == ["₹4,350", "₹4,280", "₹4,210", "₹4,190", "₹4,210", "₹5,328"]
    assert "लातूर" in doc and "हमीभाव" in doc and "₹ प्रति क्विंटल" in doc


def test_end_card_and_source_line(doc):
    assert "गावाच्या WhatsApp ग्रुपवर पाठवा" in doc
    src = [e for e in _events(doc) if ",Source," in e and "स्रोत" in e]
    assert len(src) == 1 and src[0].split(",")[1] == "0:00:00.00"


def test_events_sorted_and_times_valid(doc):
    t = lambda s: sum(float(x) * m for x, m in zip(s.split(":"), (3600, 60, 1)))  # noqa: E731
    starts = []
    for e in _events(doc):
        f = e.split(",")
        assert re.fullmatch(r"\d:\d\d:\d\d\.\d\d", f[1]) and t(f[2]) >= t(f[1])
        starts.append(t(f[1]))
    assert starts == sorted(starts)


def test_escaping_blocks_override_injection(tmp_path):
    evil = "भाव {\\pos(0,0)\\c&H0000FF&} आहे \\N नवी ओळ"
    esc = ass_escape(evil)
    assert "{" not in esc.replace("\\{", "") and "}" not in esc.replace("\\}", "")
    assert "\\N" not in esc                    # backslash separated from N by a word joiner
    script = sample_script(hook=Hook(voice_mr="आज सोयाबीनचे भाव पाहूया.", onscreen_mr=evil))
    doc = build_ass(script, sample_timeline(tmp_path, script), sample_plan(), None)
    hook = next(e for e in _events(doc) if ",Hook," in e)
    assert "\\pos(0,0)" not in hook.replace("\\{\\", "")


def test_helpers():
    assert ass_colour("#e0af3b") == "&H003BAFE0"
    assert ass_colour("#005f21", 0x80) == "&H80215F00"
    assert ass_time(0) == "0:00:00.00" and ass_time(61.456) == "0:01:01.46"
    assert wrap_lines("सोयाबीन आज ₹४,३५० लातूर बाजार समितीत विक्री") == ["सोयाबीन आज ₹४,३५०", "लातूर बाजार समितीत विक्री"]
    assert wrap_lines("एक\nदोन\nतीन") == ["एक", "दोन तीन"]
    assert wrap_lines("लहान ओळ") == ["लहान ओळ"]
    assert highlight_numbers("दर 2.5 टक्के") == "दर {\\1c&H3BAFE0&}2.5{\\1c&HFFFFFF&} टक्के"


def test_fonts_from_brand_and_fit_scale():
    fonts = load_fonts(REPO_MARKETING / "assets" / "fonts", sample_brand())
    assert fonts["Hook"].family == "Baloo 2" and fonts["Hook"].bold
    assert fonts["Caption"].file.name == "Mukta-ExtraBold.ttf" and fonts["Caption"].file.is_file()
    assert fit_scale(["लहान"], fonts["Caption"], 70) == 100
    assert fit_scale(["क्षेत्र " * 12], fonts["Caption"], 70) < 100
    assert fit_scale(["x" * 200], FontSpec("Mukta"), 70) == 100     # no file: no estimate


def test_snapshot_head(doc):
    """Snapshot of the stable header + first events (times depend only on FakeTTS)."""
    lines = doc.splitlines()
    assert lines[:8] == ["[Script Info]", "; KrushiSarva marketing autopilot", "ScriptType: v4.00+", "PlayResX: 1080",
                         "PlayResY: 1920", "WrapStyle: 2", "ScaledBorderAndShadow: yes", "YCbCr Matrix: TV.709"]
    ev = _events(doc)
    assert ev[0].startswith("Dialogue: 1,0:00:00.00,") and ",Source," in ev[0]
    assert ev[1].startswith("Dialogue: 1,0:00:00.00,") and ",Hook," in ev[1]
    assert ev[1].endswith("{\\fad(150,0)}सोयाबीन {\\1c&H3BAFE0&}₹४,३५०{\\1c&HFFFFFF&} लातूर")


def test_wrap_lines_never_drops_author_lines():
    assert wrap_lines("एक\nदोन\nतीन नाही") == ["एक", "दोन तीन नाही"]
    assert wrap_lines("एक\nदोन") == ["एक", "दोन"]
