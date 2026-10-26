import itertools

import pytest

from _media_fixtures import sample_brand, sample_payload, sample_timeline, sample_script
from ksm.render import layout as L


def test_text_regions_inside_safe_zone():
    for name, box in L.TEXT_REGIONS.items():
        assert box.inside(L.SAFE_BOX), name
    assert L.WATERMARK_BOX.inside(L.SAFE_BOX)
    assert (L.WATERMARK_BOX.x, L.WATERMARK_BOX.y, L.WATERMARK_BOX.w) == (740, 390, 140)
    assert L.TAG_POS == (70, 390)
    assert L.SAFE == dict(x0=70, x1=880, y0=380, y1=1250)


def test_regions_that_share_the_screen_do_not_overlap():
    always = [L.TAG_BOX, L.WATERMARK_BOX, L.CAPTION_BOX, L.SOURCE_BOX]
    for a, b in itertools.combinations(always, 2):
        assert not a.overlaps(b)
    for scene_box in (L.HOOK_BOX, L.LABEL_BOX, L.CHART_BOX, L.END_TEXT_BOX):
        for fixed in always:
            assert not scene_box.overlaps(fixed), (scene_box, fixed)
    assert not L.LABEL_BOX.overlaps(L.CHART_BOX)
    assert not L.CHART_BOX.overlaps(L.UNIT_BOX)


def test_bar_layout_inside_chart_and_proportional():
    rows = L.data_rows("mandi_bars", sample_payload(), "commodities[0]")
    assert [r.label for r in rows] == ["लातूर", "अकोला", "वाशिम", "हिंगोली"]     # top 4 by modal
    geoms = L.bar_layout(rows)
    for g in geoms:
        assert g.track.inside(L.CHART_BOX) and g.bar.inside(g.track)
        assert g.label_pos[1] + g.font_size <= g.track.y      # text row sits above its bar
        assert L.SAFE["x0"] <= g.label_pos[0] and g.value_pos[0] <= L.SAFE["x1"]
    assert geoms[0].bar.w == L.CHART_BOX.w
    assert geoms[1].bar.w == round(L.CHART_BOX.w * 4280 / 4350)


def test_msp_rows_and_bad_refs():
    rows = L.data_rows("msp_compare", sample_payload(), "commodities[0]")
    assert [(r.value, r.highlight) for r in rows] == [(4210, False), (5328, True)]
    assert L.data_rows("mandi_bars", sample_payload(), "commodities[9]") == []
    assert L.data_rows("mandi_bars", sample_payload(), None) == []
    assert L.resolve_ref(sample_payload(), "commodities[0].markets[1].market") == "Akola"


@pytest.mark.parametrize("v,s", [(4350, "₹4,350"), (125000, "₹1,25,000"), (999, "₹999"),
                                 (10000000, "₹1,00,00,000"), (4350.5, "₹4,350.50")])
def test_format_inr(v, s):
    assert L.format_inr(v) == s


def test_asset_allow_list():
    brand = sample_brand()
    assert L.asset_allowed("CROP-Soybean", brand)
    assert L.asset_allowed("SCENE-sowing", brand)
    for bad in ("SYMPTOM-wilting", "SCOUT-pest", "SEV-high", "ACT-SPRAY", "ACT-FERTILIZER", "ACT-SCOUT",
                "CAT-fertilizer", "AI-avatar", "../CROP-x", None, ""):
        assert not L.asset_allowed(bad, brand), bad
    ill = brand["illustrations"]
    assert 35 <= len(ill["candidates"]) <= 60
    assert all(L.asset_allowed(c, brand) for c in ill["candidates"])


def test_scene_spans_cover_narration(tmp_path):
    script = sample_script()
    tl = sample_timeline(tmp_path, script)
    spans = L.scene_spans(tl, len(script.segments))
    assert len(spans) == len(script.segments) + 2
    assert spans[0][0] == 0
    for (a0, a1), (b0, _) in zip(spans, spans[1:]):
        assert a1 == b0 and a1 > a0
    assert spans[-1][1] >= tl.total_s + L.TAIL_S
    assert spans[-1][1] <= tl.total_s + L.END_SILENCE_MAX_S + 1e-9
