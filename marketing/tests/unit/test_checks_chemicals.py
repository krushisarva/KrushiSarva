from __future__ import annotations

import json
from pathlib import Path

import pytest

from _checks_fixtures import blocking_codes, codes, make_script, with_segment_voice
from ksm.checks.chemicals import check_chemicals, load_lexicon, load_registry

MARKETING = Path(__file__).resolve().parents[2]
CHEMICALS_PY = MARKETING.parent / "fastapi" / "safety" / "chemicals.py"


def _load_sync_module():
    import importlib.util
    spec = importlib.util.spec_from_file_location("_sync_registry", MARKETING / "scripts" / "sync_registry.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.mark.skipif(not CHEMICALS_PY.exists(), reason="fastapi registry not in this checkout")
def test_snapshot_matches_registry_version():
    """Fails when fastapi/safety/chemicals.py changes without `python scripts/sync_registry.py`."""
    sync = _load_sync_module()
    mod = sync.load_chemicals(CHEMICALS_PY)
    snap = load_registry()
    assert snap["registry_version"] == mod.REGISTRY_VERSION
    assert snap == sync.build_snapshot(mod)


def test_sync_script_writes_and_checks(tmp_path):
    if not CHEMICALS_PY.exists():
        pytest.skip("fastapi registry not in this checkout")
    sync = _load_sync_module()
    out = tmp_path / "snap.json"
    assert sync.main(["--out", str(out)]) == 0
    assert json.loads(out.read_text(encoding="utf-8"))["banned_actives"]
    assert sync.main(["--out", str(out), "--check"]) == 0
    out.write_text("{}", encoding="utf-8")
    assert sync.main(["--out", str(out), "--check"]) == 1


def test_lexicon_shape():
    lex = load_lexicon()
    assert len(lex["actives_mr"]) + len(lex["brands_mr"]) >= 60
    for key in ("class_nouns_mr", "fertilisers_mr", "allowed_phrases"):
        assert lex[key]


def test_clean_script_passes():
    r = check_chemicals(make_script())
    assert r.ok and not r.issues


@pytest.mark.parametrize("text,code", [
    ("Spray mancozeb now", "chemical_mentioned"),
    ("MANCOZEB", "chemical_mentioned"),
    ("Confidor वापरा", "chemical_mentioned"),
    ("Use Emamectin Benzoate", "chemical_mentioned"),
    ("monocrotophos", "chemical_banned"),
    ("chlorpyrifos", "chemical_banned"),
    ("Lambda-Cyhalothrin", "chemical_banned"),       # state-level ban, hyphen/space/case variants             # state-level ban (Kerala)
    ("cypermethrin", "chemical_mentioned"),          # not in registry, in lexicon extras
    ("Urea आणि DAP द्या", "fertiliser_mentioned"),
    ("pesticide", "pesticide_class_mentioned"),
])
def test_latin_terms(text, code):
    r = check_chemicals(with_segment_voice(text))
    assert code in blocking_codes(r)
    assert r.issues[0].where == "segments[0].voice_mr"


def test_latin_word_boundary():
    # 'dap' inside 'adapt', 'urea' inside 'ureas' style compounds must not match
    assert check_chemicals(with_segment_voice("adapt your plan; bureaucracy")).ok


@pytest.mark.parametrize("text,code", [
    ("इमिडाक्लोप्रिडची फवारणी", "chemical_mentioned_mr"),
    ("क्लोरपायरीफॉस", "chemical_mentioned_mr"),
    ("मॅन्कोझेब", "chemical_mentioned_mr"),
    ("मँकोझेब", "chemical_mentioned_mr"),            # अ‍ॅ / ZWJ-free variants normalise
    ("कार्बेन्डाझिम", "chemical_mentioned_mr"),
    ("थायामेथोक्झाम", "chemical_mentioned_mr"),
    ("प्रोफेनोफॉस", "chemical_mentioned_mr"),
    ("सायपरमेथ्रिन", "chemical_mentioned_mr"),
    ("ग्लायफोसेट", "chemical_mentioned_mr"),
    ("ॲक्टारा", "chemical_mentioned_mr"),
    ("अ‍ॅक्टारा", "chemical_mentioned_mr"),
    ("युरियाचा डोस", "fertiliser_mentioned_mr"),
    ("डीएपी खत", "fertiliser_mentioned_mr"),
    ("कीटकनाशकांचा वापर", "pesticide_class_mentioned"),
    ("बुरशीनाशक", "pesticide_class_mentioned"),
    ("तणनाशक", "pesticide_class_mentioned"),
    ("कीडनाशक", "pesticide_class_mentioned"),
    ("रसायन फवारणी करा", "pesticide_class_mentioned"),
])
def test_devanagari_lexicon(text, code):
    assert code in blocking_codes(check_chemicals(with_segment_voice(text)))


def test_devanagari_not_matched_mid_word():
    # 'टिल्ट' brand must not match inside a longer word starting elsewhere
    assert check_chemicals(with_segment_voice("सहजपणेटिल्टसारखे")).ok


@pytest.mark.parametrize("text", [
    "पावसाचा अंदाज असल्यास फवारणी टाळा.",
    "शंका असल्यास कृषी अधिकारी किंवा कृषी सहाय्यक यांचा सल्ला घ्या.",
    "जवळच्या KVK किंवा कृषी विज्ञान केंद्राशी संपर्क करा.",
    "पेरणीपूर्वी बीजप्रक्रिया करा.",
    "शेणखत आणि सेंद्रिय खत वापरा.",
])
def test_allowed_phrases_do_not_trigger(text):
    r = check_chemicals(with_segment_voice(text))
    assert r.ok and not r.issues, r.issues


@pytest.mark.parametrize("text", [
    "२ मिली/लिटर पाण्यात", "2 ml/L", "2.5 g/L", "५० किलो/एकर", "50 kg per acre", "३० किलो एकरी",
    "प्रति लिटर पाण्यात 2 मिली", "10 लिटर पाण्यात 20 मिली मिसळा", "25% EC", "75 % WP", "५ % SC", "19:19:19",
])
def test_dose_patterns(text):
    assert "chemical_dose" in blocking_codes(check_chemicals(with_segment_voice(text)))


def test_seed_rate_warns_not_blocks():
    r = check_chemicals(with_segment_voice("हरभरा बियाणे 30 किलो प्रति एकर वापरा."))
    assert r.ok
    assert codes(r) == ["dose_seed_rate"]


def test_plain_numbers_and_prices_are_not_doses():
    r = check_chemicals(with_segment_voice("भाव 4,892 रुपये प्रति क्विंटल, उत्पादन 10 क्विंटल प्रति एकर"))
    assert r.ok and not r.issues


def test_ambiguous_alias_warns_only():
    s = make_script()
    s.platform.yt.description = "Check your credit score"
    r = check_chemicals(s)
    assert r.ok and codes(r) == ["chemical_alias_ambiguous"]


def test_chemicals_mentioned_en_must_be_empty():
    r = check_chemicals(make_script(chemicals_mentioned_en=["mancozeb"]))
    assert "chemicals_mentioned_en" in blocking_codes(r)


def test_claim_text_is_screened():
    s = make_script()
    s.claims[0].text_mr = "मॅन्कोझेब वापरा"
    r = check_chemicals(s)
    assert [i.where for i in r.issues] == ["claims[0].text_mr"]


@pytest.mark.parametrize("text", [
    "20 मिली प्रति 10 लिटर पाणी", "2 ml per 10 litres", "20 ml/10 L", "2 मिली/लि. पाणी", "एकरी 50 किलो द्या",
    "हेक्टरी 100 किलो", "25 टक्के ईसी", "4 ग्रॅम प्रति किलो बियाणे", "15 लिटर पंपाला 30 मिली", "10 ग्रॅम/किलो",
])
def test_dose_pattern_gaps_closed(text):
    """Common Marathi dose phrasings that used to pass the screen."""
    assert "chemical_dose" in blocking_codes(check_chemicals(with_segment_voice(text)))


@pytest.mark.parametrize("text", ["एकरी 2 lakh रुपये", "एकरी 4 क्विंटल उत्पादन", "भाव 4,892 रुपये प्रति क्विंटल"])
def test_dose_patterns_do_not_hit_prices_or_yields(text):
    r = check_chemicals(with_segment_voice(text))
    assert r.ok and not r.issues, r.issues


def test_seed_rate_either_word_order_warns():
    r = check_chemicals(with_segment_voice("हेक्टरी 20 किलो बियाणे वापरा."))
    assert r.ok and codes(r) == ["dose_seed_rate"]


@pytest.mark.parametrize("text,code", [
    ("रोगर", "chemical_mentioned_mr"), ("नुवान", "chemical_mentioned_mr"), ("एम-४५", "chemical_mentioned_mr"),
    ("सल्फरची फवारणी", "chemical_mentioned_mr"), ("ट्रायकोडर्मा", "chemical_mentioned_mr"),
    ("Trichoderma", "chemical_mentioned"), ("Rogor", "chemical_mentioned"),
])
def test_added_common_brands_and_bioagents(text, code):
    assert code in blocking_codes(check_chemicals(with_segment_voice(text)))
