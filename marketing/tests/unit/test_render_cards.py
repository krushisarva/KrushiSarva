from PIL import Image

from _media_fixtures import REPO_MARKETING, sample_brand, sample_plan, sample_script
from ksm.models import Segment, Visual
from ksm.render.cards import build_cards, card_kind, illustration_path
from ksm.render.layout import PALETTE, bar_layout, data_rows


def _assets(tmp_path, with_ill=("CROP-Soybean", "SYMPTOM-wilting")):
    assets = tmp_path / "assets"
    (assets / "illustrations").mkdir(parents=True)
    (assets / "brand").mkdir()
    Image.open(REPO_MARKETING / "assets" / "brand" / "splash-mark.png").save(assets / "brand" / "splash-mark.png")
    for a in with_ill:
        Image.new("RGBA", (400, 400), (200, 40, 40, 255)).save(assets / "illustrations" / f"{a}.png")
    return assets


def test_cards_are_1080x1920_one_per_scene(tmp_path):
    script = sample_script()
    paths = build_cards(script, sample_plan(), tmp_path / "cards", _assets(tmp_path), brand=sample_brand())
    assert len(paths) == len(script.segments) + 2
    assert [card_kind(p) for p in paths] == ["title", "mandi_bars", "msp_compare", "illustration", "end_card"]
    for p in paths:
        with Image.open(p) as im:
            assert im.size == (1080, 1920) and im.mode == "RGB"


def test_bars_drawn_in_brand_colours(tmp_path):
    rgb = lambda h: tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))  # noqa: E731
    plan = sample_plan()
    paths = build_cards(sample_script(), plan, tmp_path / "c", _assets(tmp_path), brand=sample_brand())
    for path, kind in ((paths[1], "mandi_bars"), (paths[2], "msp_compare")):
        geoms = bar_layout(data_rows(kind, plan.payload, "commodities[0]"))
        with Image.open(path) as im:
            for g in geoms:
                mid = (g.bar.x + g.bar.w // 2, g.bar.y + g.bar.h // 2)
                assert im.getpixel(mid) == rgb(PALETTE["gold"] if g.row.highlight else PALETTE["glow"])
    assert any(g.row.highlight for g in bar_layout(data_rows("msp_compare", plan.payload, "commodities[0]")))


def test_forbidden_assets_never_used(tmp_path):
    assets = _assets(tmp_path)
    brand = sample_brand()
    assert illustration_path("CROP-Soybean", assets, brand) is not None
    assert illustration_path("SYMPTOM-wilting", assets, brand) is None     # file exists, still refused
    assert illustration_path("CROP-Missing", assets, brand) is None
    script = sample_script(segments=[
        Segment(voice_mr="पहिला भाग इथे आहे.", onscreen_mr="एक", visual=Visual(kind="illustration", asset_id="SYMPTOM-wilting")),
        Segment(voice_mr="दुसरा भाग इथे आहे.", onscreen_mr="दोन", visual=Visual(kind="step_card")),
        Segment(voice_mr="तिसरा भाग इथे आहे.", onscreen_mr="तीन", visual=Visual(kind="broll", asset_id="123")),
    ])
    paths = build_cards(script, sample_plan(), tmp_path / "c", assets, brand=brand)
    with Image.open(paths[1]) as im:     # the red test image would show at the centre if it had been used
        r, g, b = im.getpixel((540, 1000))
        assert not (r > 150 and g < 80)
