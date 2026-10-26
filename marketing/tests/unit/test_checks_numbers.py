from __future__ import annotations

import pytest

from _checks_fixtures import codes, make_script, mandi_payload, with_segment_voice
from ksm.checks.numbers import canonical, check_numbers, extract_numbers, payload_numbers, resolve_ref
from ksm.models import Claim


@pytest.mark.parametrize("raw,expected", [
    ("4,892", "4892"), ("४,८९२", "4892"), ("₹4,892.00", "4892"), ("1,23,456", "123456"),
    ("8.30", "8.3"), ("०५", "5"), ("12%", "12"),
])
def test_canonical(raw, expected):
    assert canonical(raw) == expected


def test_extract_handles_scripts_and_grouping():
    assert extract_numbers("भाव ₹४,८९२ आणि 1,23,456 व ९.७%") == ["4,892", "1,23,456", "9.7"]
    # a list written "10,20" is two numbers, not 1020
    assert extract_numbers("10,20 आणि 30") == ["10", "20", "30"]
    # helpline is masked out as a unit
    assert extract_numbers("कॉल 1800-180-1551 करा") == []
    assert extract_numbers("कॉल १८००-१८०-१५५१") == []


def test_payload_numbers_flatten_strings_dates_and_roundings():
    nums = payload_numbers(mandi_payload())
    assert {"4892", "5328", "2026", "10", "15", "27", "9.722222", "9.72", "9.7", "10"} <= nums
    assert "3" in nums  # three markets: list length counts as a derived fact
    assert "True" not in nums


def test_clean_script_passes():
    assert check_numbers(make_script(), mandi_payload()).ok


def test_invented_number_flagged_with_location():
    s = with_segment_voice("लातूर येथे भाव ५,१०० रुपये होता.", index=2)
    r = check_numbers(s, mandi_payload())
    assert not r.ok
    assert codes(r) == ["number_not_in_payload"]
    assert r.issues[0].where == "segments[2].voice_mr"
    assert "5,100" in r.issues[0].message


def test_number_in_platform_text_checked():
    s = make_script()
    s.platform.yt.description = "आज 37 बाजारांचा आढावा"
    r = check_numbers(s, mandi_payload())
    assert [i.where for i in r.issues] == ["platform.yt.description"]


def test_extra_allowed_and_always_allowed():
    s = make_script()
    s.cta_mr = "17 ऑक्टोबर 2027 पर्यंत, किसान कॉल सेंटर 1800-180-1551."
    assert not check_numbers(s, mandi_payload()).ok          # 17 is not in the payload
    assert check_numbers(s, mandi_payload(), extra_allowed={"2026-10-17"}).ok


def test_duplicate_number_in_one_field_reported_once():
    s = with_segment_voice("७७ आणि 77 आणि ७७", index=0)
    assert len(check_numbers(s, mandi_payload()).issues) == 1


def test_rounded_payload_value_allowed_but_other_rounding_not():
    s = with_segment_voice("सुमारे 10% कमी", index=2)       # round(9.72) = 10
    assert check_numbers(s, mandi_payload()).ok
    s = with_segment_voice("सुमारे 9.8% कमी", index=2)
    assert not check_numbers(s, mandi_payload()).ok


@pytest.mark.parametrize("text,expected", [
    ("रु.5100", ["5100"]), ("Rs.5,100 भाव", ["5,100"]), ("रु.४,८९२", ["4,892"]), ("क्र.3", ["3"]),
    ("4.5 टक्के", ["4.5"]),
])
def test_abbreviation_dot_does_not_hide_numbers(text, expected):
    """'रु.5100' used to yield nothing, so an invented price escaped the check."""
    assert extract_numbers(text) == expected


def test_invented_price_after_rupee_abbreviation_flagged():
    r = check_numbers(with_segment_voice("लातूर येथे रु.5100 भाव होता."), mandi_payload())
    assert codes(r) == ["number_not_in_payload"] and "5100" in r.issues[0].message


def test_helpline_with_unicode_hyphens_masked():
    assert extract_numbers("कॉल 1800‑180‑1551 करा") == []      # U+2011 non-breaking hyphen
    assert extract_numbers("कॉल 1800—180—1551") == []


def test_resolve_ref():
    p = mandi_payload()
    assert resolve_ref(p, "data_date")
    assert resolve_ref(p, "commodities[0].markets[2].modal")
    assert not resolve_ref(p, "commodities[3]")
    assert not resolve_ref(p, "instalment_date")
    assert not resolve_ref(p, "commodities[0].prev_median_modal")   # None is not a value
    assert not resolve_ref(p, "")


def test_date_claim_ref_must_resolve_in_payload():
    """A date claim without source_url is only sourced if its data_ref really exists."""
    ok = make_script(claims=[Claim(kind="date", text_mr="15 ऑक्टोबर", value="15 ऑक्टोबर", data_ref="data_date")])
    assert check_numbers(ok, mandi_payload()).ok
    bad = make_script(claims=[Claim(kind="date", text_mr="हप्ता 15 नोव्हेंबरला", data_ref="pm_kisan.next_instalment")])
    r = check_numbers(bad, mandi_payload())
    assert codes(r) == ["date_claim_bad_ref"] and r.issues[0].where == "claims[0]"
    sourced = make_script(claims=[Claim(kind="date", text_mr="x", data_ref="nope", source_url="https://pmkisan.gov.in/")])
    assert check_numbers(sourced, mandi_payload()).ok
