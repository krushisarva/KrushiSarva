from __future__ import annotations

from _checks_fixtures import blocking_codes, codes, make_script, mandi_payload
from ksm.checks import run_deterministic
from ksm.checks.limits import check_limits, graphemes, published_body, yt_tags_length
from ksm.models import CheckReport


def test_graphemes_count_conjuncts_as_one():
    assert graphemes("क्षेत्र") == 2          # क्षे + त्र
    assert graphemes("कृषी") == 2
    assert graphemes("abc") == 3


def test_clean_script_passes():
    r = check_limits(make_script())
    assert r.ok and not r.issues, r.issues


def test_yt_title_limits():
    s = make_script()
    s.platform.yt.title = "अ" * 101
    assert "yt_title_too_long" in blocking_codes(check_limits(s))
    s.platform.yt.title = "अ" * 100
    assert check_limits(s).ok
    s.platform.yt.title = "  "
    assert "yt_title_empty" in blocking_codes(check_limits(s))
    s.platform.yt.title = "भाव <आज>"
    assert "yt_angle_brackets" in blocking_codes(check_limits(s))


def test_yt_description_is_bytes_not_chars():
    s = make_script()
    s.platform.yt.hashtags = []
    body = "AI आवाज" + "क" * 1661 + "ab"                 # 15 + 4983 + 2 = 5000 bytes, 1670 chars
    assert len(body.encode("utf-8")) == 5000
    s.platform.yt.description = body                    # disclosure present, nothing appended
    assert check_limits(s).ok
    s.platform.yt.description = body + "c"
    assert "yt_description_too_long" in blocking_codes(check_limits(s))


def test_yt_description_counts_appended_hashtags_and_disclosure():
    """The publisher appends missing hashtags and 'निवेदन: AI आवाज'; the limit is on that text."""
    assert published_body("भाव", ["Shorts", "#शेती"]) == "भाव\n\n#Shorts #शेती\n\nनिवेदन: AI आवाज"
    assert published_body("भाव #शेती. AI आवाज", ["#शेती"]) == "भाव #शेती. AI आवाज"
    s = make_script()
    s.platform.yt.description = "क" * 1660               # 4980 bytes alone, over 5000 once composed
    s.platform.yt.hashtags = ["#Shorts"]
    r = check_limits(s)
    assert "yt_description_too_long" in blocking_codes(r)
    s.platform.yt.hashtags = ["#<x>"]
    s.platform.yt.description = "भाव AI आवाज"
    assert "yt_angle_brackets" in blocking_codes(check_limits(s))


def test_yt_tags_total():
    assert yt_tags_length(["a b", "cd"]) == 5 + 2 + 1
    s = make_script()
    s.platform.yt.tags = ["x" * 50] * 10              # 500 + 9 commas
    assert "yt_tags_too_long" in blocking_codes(check_limits(s))


def test_hashtags_counted_from_caption_and_list():
    s = make_script()
    s.platform.ig.caption = "भाव #शेतकरी #शेती #soybean"
    s.platform.ig.hashtags = ["#शेती", "बाजारभाव", "#maharashtra", "#latur"]   # union = 6
    r = check_limits(s)
    assert "too_many_hashtags" in blocking_codes(r)
    assert r.issues[0].where == "platform.ig"


def test_ig_caption_length_includes_appended_hashtags():
    s = make_script()
    s.platform.ig.caption = "अ" * 2190
    s.platform.ig.hashtags = ["#शेतकरी", "#शेती"]
    assert "ig_caption_too_long" in blocking_codes(check_limits(s))


def test_ig_caption_length_includes_ai_disclosure():
    s = make_script()
    s.platform.ig.hashtags = []
    s.platform.ig.caption = "अ" * 2190                    # +2 newlines +14 disclosure = 2206
    assert "ig_caption_too_long" in blocking_codes(check_limits(s))
    s.platform.ig.caption = "अ" * 2193 + "AI आवाज"         # 2200, disclosure already present
    assert check_limits(s).ok


def test_fb_links():
    s = make_script()
    s.platform.fb.caption = "माहिती https://example.com वर"
    assert "fb_caption_link" in blocking_codes(check_limits(s))
    s.platform.fb.caption = "स्रोत: data.gov.in"
    r = check_limits(s)
    assert r.ok and codes(r) == ["fb_caption_domain"]


def test_onscreen_lines():
    s = make_script()
    s.segments[1].onscreen_mr = "अ" * 23
    r = check_limits(s)
    assert "onscreen_line_too_long" in blocking_codes(r) and r.issues[0].where == "segments[1].onscreen_mr"
    s = make_script()
    s.hook.onscreen_mr = "एक\nदोन\nतीन"
    assert "onscreen_too_many_lines" in blocking_codes(check_limits(s))
    s = make_script()
    s.hook.onscreen_mr = "क्षेत्र " * 3           # 3*(2+1) graphemes = 9 even though many code points
    assert check_limits(s).ok


def test_narration_and_segment_voice_lengths():
    s = make_script()
    s.segments[0].voice_mr = "अ" * 221
    assert "segment_voice_too_long" in blocking_codes(check_limits(s))
    s = make_script()
    for seg in s.segments:
        seg.voice_mr = "अ" * 200
    s.cta_mr = "अ" * 200
    assert "narration_too_long" in blocking_codes(check_limits(s))


def test_run_deterministic_combines_all():
    s = make_script()
    s.segments[0].voice_mr = "भाव ६,००० रुपये होईल, इमिडाक्लोप्रिड वापरा, भाव वाढणार."
    s.segments[1].onscreen_mr = "अ" * 30
    r = run_deterministic(s, mandi_payload(), series="mandi", app_cta_url=None)
    assert isinstance(r, CheckReport) and not r.ok
    got = set(codes(r))
    assert {"number_not_in_payload", "chemical_mentioned_mr", "price_prediction",
            "onscreen_line_too_long"} <= got
    assert "segments[0].voice_mr" in r.feedback()


def test_run_deterministic_clean_and_extra_allowed():
    s = make_script()
    assert run_deterministic(s, mandi_payload(), series="mandi", app_cta_url=None).ok
    s.cta_mr = "17 ऑक्टोबरला पुन्हा पाहा."
    assert not run_deterministic(s, mandi_payload(), series="mandi", app_cta_url=None).ok
    assert run_deterministic(s, mandi_payload(), series="mandi", app_cta_url=None,
                             extra_allowed={"2026-10-17"}).ok
