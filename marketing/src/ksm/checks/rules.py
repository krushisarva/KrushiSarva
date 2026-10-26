"""Editorial rules: no price predictions, no politics, no download CTA before the
app is public, no unsourced dates, only the real Kisan Call Centre number, and
no income/yield guarantees.

Rules work sentence by sentence because Marathi future-tense verbs (वाढेल,
कमी होईल) are only a prediction when the sentence is about prices or income;
"पाणी धरून ठेवण्याची क्षमता वाढेल" is ordinary sourced advice and only warns.
"""
from __future__ import annotations

import re

from ..models import CheckReport, Issue, VideoScript
from ._text import NOT_DEV_AFTER, NOT_DEV_BEFORE, latin_digits, norm_mr, published_texts

KCC_NUMBER = "1800-180-1551"

_B, _A = NOT_DEV_BEFORE, NOT_DEV_AFTER
_SENT_SPLIT = re.compile(r"[.।!?\n|]+")


def _dev_words(*words: str, suffix: bool = True) -> str:
    """Alternation anchored at a Devanagari word start; suffixes allowed unless suffix=False."""
    body = "|".join(re.escape(w) for w in words)
    return f"{_B}(?:{body})" + ("" if suffix else _A)


# ── Predictions ───────────────────────────────────────────────────────────────
_PRICE_CTX = re.compile(
    _dev_words("भाव", "बाजारभाव", "हमीभाव", "किंमत", "किमत", "रेट", "दरवाढ", "दरात")
    + "|" + f"{_B}दर(?:ात|ाने|ांत|ाचा|ाची|ाचे|ांना|ाला|ां)?{_A}"
    + r"|\b(?:price|prices|rate|rates|mandi|MSP)\b", re.IGNORECASE)
_INCOME_CTX = re.compile(_dev_words("उत्पन्न", "उत्पादन", "नफा", "नफ्या", "कमाई", "पैसे")
                         + r"|\b(?:income|yield|profit|earning)s?\b", re.IGNORECASE)
_ALWAYS_PREDICTION = re.compile(
    r"(?:भाव|दर|किंमत|बाजारभाव)\S*\s+(?:वाढणार|वाढतील|पडणार|घसरणार|उतरणार|कोसळणार)"
    r"|तेजी\s+(?:येणार|येईल)|मंदी\s+(?:येणार|येईल)")
_FUTURE = re.compile(
    _dev_words("वाढेल", "वाढतील", "वाढणार", "पडेल", "पडतील", "पडणार", "घसरेल", "घसरतील", "घसरणार",
               "उतरेल", "उतरतील", "उतरणार", "कोसळेल", "कोसळतील", "कोसळणार", "वधारेल", "वधारतील", "वधारणार",
               "घटेल", "घटतील", "घटणार", "सुधारेल", "सुधारतील", "वाढण्याची", "घसरण्याची", "वधारण्याची")
    + r"|(?:वाढू|घसरू|पडू|उतरू|वधारू|घटू)\s+शक|कमी\s+होऊ\s+शक|कमी\s+होण्याची"
    + r"|कमी\s+होईल|कमी\s+होणार|कमी\s+होतील|जास्त\s+होईल"
    + r"|\bwill\s+(?:rise|fall|go\s+up|go\s+down|increase|decrease|drop|crash)\b", re.IGNORECASE)
_FORECAST = re.compile(_dev_words("अंदाज", "शक्यता")
                       + r"|\b(?:forecast|prediction|predict|likely|expected)\w*\b", re.IGNORECASE)
_CERTAIN = re.compile(_dev_words("नक्की", "निश्चितच"))
# "नक्की पाहा / शेअर करा" is an ordinary call to action and "नक्की किती?" a question,
# not a certainty claim.
_CERTAIN_CTA = re.compile(
    r"(?:नक्की|निश्चित)च?\s+(?:पाहा|पहा|बघा|शेअर|सांगा|कळवा|वाचा|फॉलो|सबस्क्राइब|सबस्क्राईब|कमेंट|लाईक|लाइक|ऐका|विचारा|संपर्क"
    r"|किती|काय|कोण|कधी|कुठे|कसा|कशी|कसे)")

# ── Selling advice ────────────────────────────────────────────────────────────
_SELL_ADVICE = re.compile(
    r"(?:आत्ता|आता|आताच|लगेच|त्वरित|लवकर)\s+(?:\S+\s+)?विका|विकू\s+नका|विक्री\s+(?:थांबवा|टाळा|करू\s+नका)"
    r"|घाईने\s+विक"
    r"|\b(?:sell\s+now|don'?t\s+sell|hold\s+(?:your\s+)?(?:stock|crop|produce))\b", re.IGNORECASE)
# "साठवून ठेवा" is ordinary storage advice for seed; it is holding advice only next to prices/sale.
_HOLD = re.compile(r"(?:साठवून|राखून|थांबवून)\s+ठेवा")
_SALE_CTX = re.compile(_dev_words("विक", "विक्री"))

# ── Guarantees ────────────────────────────────────────────────────────────────
_GUARANTEE = re.compile(
    _dev_words("हमखास", "गॅरंटी", "गॅरेंटी")
    + r"|खात्रीने\s+(?:उत्पन्न|उत्पादन|नफा)|दुप्पट\s+(?:उत्पन्न|उत्पादन|नफा)|(?:उत्पन्न|उत्पादन|नफा)\S*\s+दुप्पट"
    + r"|100\s*%\s*(?:नफा|उत्पन्न|उत्पादन)"
    + r"|\bguarantee[ds]?\b|\bdouble\s+(?:your\s+)?(?:income|yield|profit)\b", re.IGNORECASE)
# "खात्रीशीर पाणी" (an assured water supply) is sowing advice; only a guarantee next to income/yield.
_ASSURED = re.compile(_dev_words("खात्रीशीर", "खात्रीने"))

# ── Politics ──────────────────────────────────────────────────────────────────
_PARTIES = re.compile(
    _dev_words("भाजप", "भाजपा", "काँग्रेस", "कॉंग्रेस", "काॅंग्रेस", "शिवसेन", "राष्ट्रवाद", "मनसे")
    + "|" + _dev_words("आप", suffix=False) + "|आम\\s+आदमी\\s+पार्टी"
    + r"|\b(?:BJP|AAP|NCP|MNS|INC)\b")
_PARTIES_CI = re.compile(r"\b(?:congress|shiv\s*sena|aam\s+aadmi|bharatiya\s+janata)\b", re.IGNORECASE)
_POLITICIANS = re.compile(
    _dev_words("मोदी", "फडणवीस", "शिंदे", "पवार", "ठाकरे", "गांधी", "निवडणुक", "निवडणूक", "आमदार", "खासदार")
    + r"|\b(?:modi|fadnavis|shinde|pawar|thackeray|gandhi|elections?|MLAs?)\b", re.IGNORECASE)
# The national figure in an official scheme name (महात्मा गांधी राष्ट्रीय ग्रामीण रोजगार हमी योजना)
# is not a political reference; only this exact phrase is excused.
_NAME_ALLOWED = re.compile(r"महात्मा\s+गांधी|mahatma\s+gandhi", re.IGNORECASE)
_OFFICE = re.compile(_dev_words("मुख्यमंत्र", "पंतप्रधान", "प्रधानमंत्र", "मंत्री", "मंत्र्या",
                                "कृषीमंत्र", "कृषिमंत्र")  # stems: मुख्यमंत्र्यांनी
                     + r"|\b(?:prime\s+minister|chief\s+minister|minister|PM|CM)\b")
# Official scheme names that contain an office title (पीएम किसान, मुख्यमंत्री सौर कृषी पंप योजना).
_SCHEME_NAME = re.compile(
    r"(?:पीएम|पी\.एम\.|PM)[\s\-]*(?:किसान|KISAN|Kisan|कुसुम|KUSUM)"
    r"|(?:पंतप्रधान|प्रधानमंत्री|मुख्यमंत्री|प्रधान\s+मंत्री)(?:\s+\S+){0,6}?\s+(?:योजना|निधी|अभियान|सन्मान)"
    r"|\b(?:PM|CM)[\s\-]+(?:\S+\s+){0,5}?(?:Yojana|Scheme|Nidhi|Abhiyan|Bima)\b",
    re.IGNORECASE)

# ── Download CTA ──────────────────────────────────────────────────────────────
_DOWNLOAD = re.compile(
    _dev_words("डाउनलोड", "डाऊनलोड", "इन्स्टॉल", "इंस्टॉल", "इन्स्टाॅल", "प्ले स्टोअर", "प्ले स्टोर", "प्लेस्टोअर")
    + r"|\b(?:download|install|play\s*store|app\s*store|google\s+play)\b", re.IGNORECASE)

# ── Kisan Call Centre ─────────────────────────────────────────────────────────
_KCC = re.compile(r"किसान\s*कॉल\s*से|kisan\s+call\s+cent(?:re|er)|\bKCC\b", re.IGNORECASE)
_SEP = r"[\s\-–‐‑‒—]"
_KCC_NUMBER = re.compile(rf"(?<![0-9])1800{_SEP}?180{_SEP}?1551(?![0-9])")
# Phone-like: grouped 3-5/3/3-4 digits, a 5+5 mobile, or an ungrouped 10-11 digit run.
_PHONE = re.compile(rf"(?<![0-9])(?:[0-9]{{3,5}}{_SEP}[0-9]{{3}}{_SEP}[0-9]{{3,4}}|[0-9]{{5}}{_SEP}[0-9]{{5}}"
                    r"|[0-9]{10,11})(?![0-9])")


def _sentences(text: str) -> list[str]:
    return [s for s in _SENT_SPLIT.split(text) if s.strip()]


def check_rules(script: VideoScript, *, series: str, app_cta_url: str | None) -> CheckReport:
    """`series` is accepted for per-series rules; every rule here applies to all series."""
    report = CheckReport()

    def add(code: str, msg: str, where: str, blocking: bool = True) -> None:
        if not any(i.code == code and i.where == where for i in report.issues):
            report.issues.append(Issue(code=code, message=msg, blocking=blocking, where=where))

    for where, raw in published_texts(script):
        text = latin_digits(norm_mr(raw))
        for sent in _sentences(text):
            price, income = _PRICE_CTX.search(sent), _INCOME_CTX.search(sent)
            if m := _ALWAYS_PREDICTION.search(sent):
                add("price_prediction", f"'{m.group(0)}' predicts prices; report only past data", where)
            if (m := _FUTURE.search(sent)) or (m := _FORECAST.search(sent)):
                if price:
                    add("price_prediction", f"'{m.group(0)}' with a price word predicts prices; "
                        "state only what the data shows", where)
                elif income and _FUTURE.search(sent):
                    add("income_guarantee", f"'{m.group(0)}' promises an income/yield change", where)
                elif _FUTURE.search(sent):
                    add("prediction_word", f"'{m.group(0)}' is future tense; make sure it is a sourced fact, "
                        "not a forecast", where, blocking=False)
            certain = _CERTAIN.search(_CERTAIN_CTA.sub(" ", sent))
            if certain:
                add("certainty_word", f"'{certain.group(0)}' asserts certainty; drop it unless it is a call "
                    "to action like 'नक्की शेअर करा'", where)
            if (m := _GUARANTEE.search(sent)) or (income and (m := _ASSURED.search(sent))):
                add("income_guarantee", f"'{m.group(0)}' is an income/yield guarantee", where)
            if (m := _SELL_ADVICE.search(sent)) or ((price or _SALE_CTX.search(sent)) and (m := _HOLD.search(sent))):
                add("sell_timing_advice", f"'{m.group(0)}' tells farmers when to sell or hold; "
                    "describe the data only, the farmer decides", where)

        # Office titles are excused inside an official scheme name, but names and parties
        # never are: "मुख्यमंत्री फडणवीस यांची योजना" must still be caught.
        unnamed = _NAME_ALLOWED.sub(" ", text)
        unscheme = _SCHEME_NAME.sub(" ", unnamed)
        for pat, src in ((_PARTIES, unnamed), (_PARTIES_CI, unnamed), (_POLITICIANS, unnamed), (_OFFICE, unscheme)):
            if m := pat.search(src):
                add("political_reference", f"'{m.group(0)}' is a politician/party/office reference; "
                    "name schemes, not people or parties", where)
                break

        if not app_cta_url and (m := _DOWNLOAD.search(text)):
            add("download_cta_without_url", f"'{m.group(0)}': no download/install CTA until the app is "
                "public (settings.app_cta_url); ask viewers to follow/subscribe instead", where)

        mentions_kcc = bool(_KCC.search(text))
        for p in _PHONE.finditer(_KCC_NUMBER.sub(" ", text)):
            digits = "".join(ch for ch in p.group(0) if ch.isdigit())
            if mentions_kcc or digits.startswith("1800"):
                add("wrong_helpline_number", f"phone number {digits} is not the Kisan Call Centre "
                    "number 1800-180-1551", where)

    for i, c in enumerate(script.claims):
        if c.kind == "date" and not (c.source_url or "").startswith(("https://", "http://")) and not c.data_ref:
            add("date_claim_unsourced", f"date claim '{c.text_mr}' has no official source_url; "
                "cut it or cite the official page", f"claims[{i}]")
    return report
