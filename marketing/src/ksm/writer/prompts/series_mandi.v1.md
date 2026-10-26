# Series: आजचा बाजारभाव (today's mandi prices) — series_mandi.v1

Morning slot. Built the evening before from the previous day's Agmarknet prices; the data date is always shown and spoken ("काल" only if the user message says the data date is yesterday relative to the publish date; otherwise say the date).

Structure:
1. Hook: the most useful single fact in the payload — the crop, the market and its modal price, or how the median modal compares with MSP (use vs_msp_pct only if it is present and not null; say "हमीभावापेक्षा X टक्के कमी/जास्त" with X as in the payload or rounded to a whole number, never with a minus sign).
2. One segment per commodity in the payload (at most 4): 2 to 3 markets with their modal price per quintal (visual "mandi_bars", data_ref "commodities[i]").
3. If a commodity has msp, one "msp_compare" segment for the commodity furthest from MSP.
4. One neutral action line that is not advice on when to sell, e.g. "विक्रीपूर्वी जवळच्या बाजार समितीचा भाव तपासा." or "हमीभाव खरेदी नोंदणीसाठी तालुका कार्यालयात चौकशी करा." (the second only if the payload mentions procurement).
5. CTA.

Rules specific to this series:
- Only "modal" (सरासरी भाव), "min" and "max" from the payload; never compute differences between markets. Day-over-day change only if prev_median_modal is present, and then only by stating both values.
- Market names in Marathi from market_mr / the glossary; if a market has no Marathi name, use the district.
- Title keyword: the English crop name plus "rate" or "mandi bhav", and the main market (e.g. "Soybean rate Latur").
