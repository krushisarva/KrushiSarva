"""Prompts and glossary: present, versioned, carry the safety rules, no banned strings."""
from __future__ import annotations

from importlib import resources

import pytest

from ksm.writer import claude as wc
from ksm.writer.schemas import GLOSSARY, GLOSSARY_BLOCKLIST, build_glossary

PROMPTS = ["writer.v1.md", "factcheck.v1.md", "series_mandi.v1.md", "series_rabi_guide.v1.md",
           "series_yojana.v1.md", "series_pik_doctor.v1.md"]


@pytest.mark.parametrize("name", PROMPTS)
def test_prompt_exists_and_names_its_version(name):
    text = wc.load_prompt(name)
    assert wc.prompt_version(name) in text


def test_writer_prompt_carries_rules():
    t = wc.load_prompt("writer.v1.md")
    for needle in ("550", "750", "1800-180-1551", "आवाज: AI (Sarvam)", "Devanagari only",
                   "chemicals_mentioned_en", "data_ref", "#Shorts", "No links", "WhatsApp"):
        assert needle in t, needle
    # long enough to clear the 512-token prompt-cache minimum (roughly 4 chars per token)
    assert len(t) > 4 * 512 * 2


def test_prompts_have_no_dynamic_content():
    """Silent cache invalidators (dates, ids) must not be templated into the system prompt."""
    t = wc.load_prompt("writer.v1.md")
    assert "{" not in t.replace("{type", "")  # no str.format placeholders


def test_glossary_standardises_bajarbhav_and_skips_placeholders():
    g = build_glossary()
    assert g["mandi_prices"] == "बाजारभाव"
    joined = " ".join(g.values())
    for bad in GLOSSARY_BLOCKLIST:
        assert bad not in joined
    assert "1800-180-1551" in g["kisan_call_centre"]
    assert g["ai_voice_disclosure"] == wc.AI_VOICE_LINE


def test_series_yaml_prompts_exist_for_buildable_series():
    """Every series that is built now or in a planned milestone has its prompt file."""
    import yaml

    from ksm.paths import REPO_MARKETING_DIR

    cfg = yaml.safe_load((REPO_MARKETING_DIR / "config" / "series.yaml").read_text(encoding="utf-8"))
    for s in cfg["series"]:
        if s.get("status") in ("v1", "m3", "m4") and s.get("prompt"):
            assert wc.load_prompt(s["prompt"]), s["key"]


def test_build_glossary_reads_repo_config():
    from ksm.paths import REPO_MARKETING_DIR

    g = build_glossary(REPO_MARKETING_DIR / "config")
    assert g["crop:soybean"] == "सोयाबीन"
    assert g["market:Latur"] == "लातूर"


def test_build_glossary_nested_config(tmp_path):
    (tmp_path / "crops_mr.yaml").write_text("commodities:\n  onion: {name_mr: कांदा, agmarknet: [Onion]}\n",
                                            encoding="utf-8")
    (tmp_path / "markets_mr.yaml").write_text("markets:\n  Lasalgaon: {mr: लासलगाव}\n", encoding="utf-8")
    g = build_glossary(tmp_path)
    assert g["crop:onion"] == "कांदा" and g["market:Lasalgaon"] == "लासलगाव"


def test_build_glossary_merges_config(tmp_path):
    (tmp_path / "crops_mr.yaml").write_text("soybean: सोयाबीन\ncotton: {name_mr: कापूस}\nbad: [1]\n", encoding="utf-8")
    (tmp_path / "markets_mr.yaml").write_text("- not a dict\n", encoding="utf-8")
    g = build_glossary(tmp_path)
    assert g["crop:soybean"] == "सोयाबीन" and g["crop:cotton"] == "कापूस"
    assert "crop:bad" not in g
    assert len(g) == len(GLOSSARY) + 2


def test_prompts_are_packaged():
    names = {p.name for p in resources.files("ksm.writer").joinpath("prompts").iterdir()}
    assert set(PROMPTS) <= names
