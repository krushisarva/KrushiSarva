from __future__ import annotations

import pytest

from _checks_fixtures import blocking_codes, codes, make_script, with_segment_voice
from ksm.checks.rules import check_rules
from ksm.models import Claim


def run(script, app_cta_url=None):
    return check_rules(script, series="mandi", app_cta_url=app_cta_url)


def test_clean_script_passes():
    r = run(make_script())
    assert r.ok and not r.issues, r.issues


@pytest.mark.parametrize("text", [
    "पुढच्या आठवड्यात सोयाबीनचे भाव वाढणार.",
    "दर कमी होईल असे दिसते.",
    "बाजारात तेजी येणार आहे.",
    "कापसात मंदी येणार.",
    "सोयाबीनच्या भावाचा अंदाज: 5000 रुपये.",
    "भाव वाढेल.",
    "Soybean prices will rise next week",
])
def test_price_predictions_block(text):
    r = run(with_segment_voice(text))
    assert "price_prediction" in blocking_codes(r)
    assert r.issues[0].where == "segments[0].voice_mr"


def test_weather_forecast_and_neutral_future_are_not_price_predictions():
    r = run(with_segment_voice("हवामान विभागाचा पावसाचा अंदाज पाहा."))
    assert r.ok and not r.issues
    r = run(with_segment_voice("आच्छादनामुळे जमिनीतील ओलावा टिकून राहण्याची क्षमता वाढेल."))
    assert r.ok and codes(r) == ["prediction_word"]


def test_price_words_in_other_sentences_do_not_leak():
    r = run(with_segment_voice("आजचा भाव 4,892 रुपये. ओलावा टिकवण्याची क्षमता वाढेल."))
    assert r.ok


@pytest.mark.parametrize("text", ["हा भाव नक्की वाढतो.", "नक्कीच फायदा होतो."])
def test_certainty_word_blocks(text):
    assert "certainty_word" in blocking_codes(run(with_segment_voice(text)))


@pytest.mark.parametrize("text", ["व्हिडिओ नक्की शेअर करा.", "नक्की पाहा", "नक्कीच कळवा"])
def test_certainty_cta_allowed(text):
    assert run(with_segment_voice(text)).ok


@pytest.mark.parametrize("text", [
    "या पद्धतीने हमखास उत्पन्न मिळेल.", "खात्रीने उत्पन्न वाढते.", "दुप्पट उत्पन्न मिळवा.",
    "उत्पादन वाढेल.", "Guaranteed income for farmers",
])
def test_income_guarantee(text):
    assert "income_guarantee" in blocking_codes(run(with_segment_voice(text)))


@pytest.mark.parametrize("text", [
    "भाजप सरकारने", "काँग्रेसने", "शिवसेनेचे", "राष्ट्रवादीचे नेते", "मनसे", "आप पक्ष", "BJP",
    "मोदींनी घोषणा केली", "फडणवीस म्हणाले", "शिंदे सरकार", "पवारांनी", "ठाकरे", "गांधी",
    "मुख्यमंत्र्यांनी जाहीर केले", "पंतप्रधानांनी सांगितले", "Modi announced",
])
def test_politics_blocked(text):
    assert "political_reference" in blocking_codes(run(with_segment_voice(text)))


@pytest.mark.parametrize("text", [
    "पीएम किसान योजनेचा हप्ता", "PM-KISAN योजना", "पीएम-किसान", "आपल्या शेतात", "आपण पाहू",
    "पंतप्रधान किसान सन्मान निधी योजना", "मुख्यमंत्री सौर कृषी पंप योजना",
])
def test_scheme_names_and_common_words_allowed(text):
    assert "political_reference" not in codes(run(with_segment_voice(text)))


@pytest.mark.parametrize("text", ["अ‍ॅप डाउनलोड करा", "आता इन्स्टॉल करा", "Play Store वर", "प्ले स्टोअरवर", "Download now"])
def test_download_cta_needs_url(text):
    assert "download_cta_without_url" in blocking_codes(run(with_segment_voice(text)))
    assert "download_cta_without_url" not in codes(run(with_segment_voice(text), "https://play.google.com/x"))


def test_date_claim_needs_source():
    s = make_script(claims=[Claim(kind="date", text_mr="हप्ता 5 नोव्हेंबरला", value="5 नोव्हेंबर")])
    r = run(s)
    assert "date_claim_unsourced" in blocking_codes(r) and r.issues[0].where == "claims[0]"
    s = make_script(claims=[Claim(kind="date", text_mr="x", source_url="https://pmkisan.gov.in/")])
    assert run(s).ok
    s = make_script(claims=[Claim(kind="date", text_mr="आवक तारीख", data_ref="data_date")])
    assert run(s).ok
    s = make_script(claims=[Claim(kind="number", text_mr="भाव", value="4892")])
    assert run(s).ok


@pytest.mark.parametrize("text", [
    "किसान कॉल सेंटर 1800-180-1552 वर कॉल करा",
    "किसान कॉल सेंटरला १८००-१२३-४५६७ वर फोन करा",
    "Kisan Call Centre 1551801800",
    "मोफत हेल्पलाइन 1800 425 1234",
])
def test_wrong_helpline(text):
    assert "wrong_helpline_number" in blocking_codes(run(with_segment_voice(text)))


@pytest.mark.parametrize("text", [
    "किसान कॉल सेंटर 1800-180-1551 वर कॉल करा",
    "किसान कॉल सेंटर १८००-१८०-१५५१",
    "किसान कॉल सेंटर 1800 180 1551, सकाळी 6 ते रात्री 10",
])
def test_right_helpline(text):
    assert run(with_segment_voice(text)).ok


def test_politician_name_inside_scheme_phrase_still_blocked():
    """The scheme mask used to swallow the name in 'मुख्यमंत्री फडणवीस यांची योजना'."""
    assert "political_reference" in blocking_codes(run(with_segment_voice("मुख्यमंत्री फडणवीस यांची योजना")))
    assert "political_reference" in blocking_codes(run(with_segment_voice("CM Shinde Yojana")))


@pytest.mark.parametrize("text", [
    "महात्मा गांधी राष्ट्रीय ग्रामीण रोजगार हमी योजना", "PM Fasal Bima Yojana", "PMFBY",
    "प्रधान मंत्री किसान सन्मान निधी योजनेचा हप्ता", "केंद्रीय कृषी मंत्रालयाने जाहीर केले.",
])
def test_official_scheme_and_ministry_names_allowed(text):
    assert "political_reference" not in codes(run(with_segment_voice(text)))


@pytest.mark.parametrize("text", ["निवडणूक जवळ आली", "आमदारांनी भेट दिली", "खासदार", "कृषीमंत्री म्हणाले", "मंत्री यांनी"])
def test_election_and_minister_words_blocked(text):
    assert "political_reference" in blocking_codes(run(with_segment_voice(text)))


@pytest.mark.parametrize("text", [
    "हमीभाव वाढेल.", "भाव वाढण्याची शक्यता आहे.", "भाव वाढू शकतात.", "सोयाबीनचे दर वधारतील.", "भाव घटतील.",
])
def test_more_price_prediction_forms(text):
    assert "price_prediction" in blocking_codes(run(with_segment_voice(text)))


@pytest.mark.parametrize("text", ["आत्ता विका.", "भाव कमी आहे, माल साठवून ठेवा.", "विकू नका.", "Sell now"])
def test_sell_timing_advice_blocked(text):
    assert "sell_timing_advice" in blocking_codes(run(with_segment_voice(text)))


@pytest.mark.parametrize("text", [
    "बियाणे कोरड्या जागी साठवून ठेवा.", "गव्हाला खात्रीशीर पाणी लागते.", "पावसाची शक्यता आहे.",
    "आज सोयाबीनचा भाव नक्की किती?",
])
def test_ordinary_advice_and_questions_pass(text):
    assert run(with_segment_voice(text)).ok


def test_assured_income_is_guarantee():
    assert "income_guarantee" in blocking_codes(run(with_segment_voice("खात्रीशीर उत्पन्न मिळते.")))


@pytest.mark.parametrize("text", [
    "किसान कॉल सेंटर 1800-180-1551 किंवा 98765 43210",
])
def test_mobile_number_next_to_kcc_blocked(text):
    assert "wrong_helpline_number" in blocking_codes(run(with_segment_voice(text)))


def test_kcc_with_unicode_hyphens_ok():
    assert run(with_segment_voice("किसान कॉल सेंटर 1800‑180‑1551")).ok


def _advisory_hints():
    from pathlib import Path

    import yaml
    path = Path(__file__).resolve().parents[2] / "config" / "advisories.yaml"
    if not path.exists():
        return []

    def walk(v):
        if isinstance(v, dict):
            for k, x in v.items():
                if k == "mr" and isinstance(x, str):
                    yield x
                else:
                    yield from walk(x)
        elif isinstance(v, list):
            for x in v:
                yield from walk(x)
    return list(walk(yaml.safe_load(path.read_text(encoding="utf-8"))))


@pytest.mark.parametrize("text", _advisory_hints() or [pytest.param("", marks=pytest.mark.skip("no advisories"))])
def test_sourced_advisory_phrasings_pass_rules_and_chemicals(text):
    """The rabi guide may only rephrase these; a false positive here means endless redos."""
    from ksm.checks.chemicals import check_chemicals
    s = with_segment_voice(text)
    assert run(s).ok and check_chemicals(s).ok


def test_writer_prompt_example_cta_passes():
    s = make_script(cta_mr="रोजचे बाजारभाव हवे असतील तर फॉलो करा. गावाच्या व्हॉट्सॲप ग्रुपवर पाठवा. तुमचा तालुका कमेंट करा.")
    assert run(s).ok
