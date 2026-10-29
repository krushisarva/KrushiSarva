# Content strategy

Two Marathi videos a day for Maharashtra farmers, on YouTube Shorts, Instagram Reels and Facebook
Reels. Every video carries real, specific information: live mandi prices, official MSP, and advice
from named sources.

Faceless, templated AI channels are the main policy risk. YouTube's "automated or synthetic
mass-production" spam rule and "inauthentic content" monetisation rule both target them, and so
do Meta's originality penalties. Real data, rotating formats and honest AI disclosure are what
keep these accounts on the right side of those rules.

The app isn't on the Play Store yet. Videos therefore end with "follow" and "share", **never**
"download the app". `settings.app_cta_url` stays empty until the listing is live, and the checks
block any download call to action while it's empty.

---

## Schedule and approvals

| Slot | Posts at (IST) | Made | You approve by |
|---|---|---|---|
| **Morning** | 07:00 | The evening before, from about 20:30, using the previous day's Agmarknet prices (the date is shown on screen) | That night (hard cut-off 06:45) |
| **Evening** | 19:00 | During the day, from 09:00 | 18:45 |

- Both times are A/B tested for 2 weeks, then fixed using analytics.
- Nothing is ever published between 22:30 and 05:30.

## Series

| Series | Slot | Milestone | Source and rules |
|---|---|---|---|
| **आजचा बाजारभाव** (today's mandi prices) | Morning, Mon–Sat | v1 | Agmarknet (data.gov.in). Top movers for soybean, cotton, onion, tur and chana at Maharashtra APMCs. |
| **रब्बी पेरणी मार्गदर्शक** (rabi sowing guide, drought year) | Evening | v1 | Sourced facts in `config/advisories.yaml` from MPKV, VNMKV, PDKV, KVK and IMD agromet. |
| **योजना अपडेट – खरं की खोटं?** (scheme news: true or false?) | Evening, about 3 a week | M3 | Drought relief, procurement registration, PMFBY and PM-KISAN. |
| **पीक डॉक्टर** (crop doctor) | Evening, 1–2 a week | M4 | Awareness only. |
| **हवामान अलर्ट** (weather alert) | Morning | Later | Open-Meteo's free tier is non-commercial. |
| **KrushiSarva कसे वापरावे** (how to use the app) | — | Later | Only once the Play listing is live. |

**आजचा बाजारभाव**
- Compared with the PIB-sourced MSP; for cotton the screen always says which staple.
- One action line per video.
- The source and the data date are on screen.
- **No predictions.**
- Day-over-day change appears only once our own snapshots exist.
- When APMCs are closed (Sundays, and Diwali week around 6–10 Nov), an evergreen video fills the slot.

**रब्बी पेरणी मार्गदर्शक**
- The AI writer (Gemini) may only rephrase the sourced facts.
- No chemicals or doses.
- An entry is used only after it's marked `verified: true`.

**योजना अपडेट – खरं की खोटं?**
- Covered only when an official source confirms it: PIB, a GR, pmkisan.gov.in or nsmny.
- The fact-check uses web search restricted to `config/sources_allowlist.yaml`. A claim with no official evidence is cut.
- That web fact-check needs Claude for now. On Gemini (the default) this series refuses to run until web checking is built for Gemini, or until `llm.provider` is set back to `anthropic` (paid).
- This is the highest-growth topic in Marathi agri media.

**पीक डॉक्टर**
- Symptoms are described in words, along with IPM and cultural practice.
- It points viewers to KVK and the Kisan Call Centre (1800-180-1551).
- **Never chemicals, never disease images.**

**हवामान अलर्ट** waits until IMD's reuse terms are confirmed or a paid weather plan is bought.

**KrushiSarva कसे वापरावे** will use emulator screen recordings.

## Video format

- **Length:** 35–58 s, never over 60 s. YouTube blocks any Short over 1 minute worldwide once it gets a copyright claim of any type, and Facebook Reels max out at 90 s.
- **Size:** 1080×1920, 30 fps.
- **Hook (first 1–2 s):** a big number, the crop and the place.
- **On screen:**
  - burned-in Marathi captions;
  - a source line;
  - the logo watermark;
  - an **"AI आवाज"** tag for the whole video.
- **End card (2.5 s):** "फॉलो करा" · "गावाच्या WhatsApp ग्रुपवर पाठवा" · "तुमचा तालुका कमेंट करा". Shares to WhatsApp groups drive reach, and sends per reach is Instagram's strongest signal for reaching non-followers.
- **Voice:** one fixed Marathi persona from Sarvam `bulbul:v4-flash`, at 48 kHz.
- **Music:** none in v1. No free music is safe on all three platforms.
- **Variety:** formats and visual templates rotate, so videos are never near-identical.

## Titles, hashtags, captions

- **YouTube:** a Marathi title plus one English crop keyword, and 3–5 hashtags in the description.
- **Instagram and Facebook:**
  - **5 hashtags or fewer**;
  - no links in the Facebook caption;
  - few capital letters.
- Hashtag sets are in `config/hashtags.yaml`.

## Safety rules

These are enforced in code, and the approval card shows each result.

- **Numbers:** every number must trace to the data payload or `config/msp.yaml`.
- **Dates:** no instalment or relief date without an official source.
- **Chemicals:** no pesticide or fertiliser names or doses. The screen checks both Latin script and Devanagari.
- **Politics:** no politicians and no parties.
- **Guarantees:** no promises of income or yield, and no price predictions.
- **Helpline:** the Kisan Call Centre number is always 1800-180-1551.
- **Crop health:** crop-health videos carry the app's Marathi diagnosis disclaimer (`shared/i18n/translations.js`, `diagnosis.disclaimer`).
- **Your approval:** nothing is published without your tap. An approval covers that exact video and its metadata, so any edit needs a new tap.

## AI disclosure

| Where | What |
|---|---|
| On screen, whole video | "AI आवाज" |
| YouTube | `containsSyntheticMedia=true` |
| Instagram | `is_ai_generated=true` |
| Facebook | `is_ai_generated=true` if the API accepts it (tested on day 0) |
| Every description | A line saying the narration is AI-generated |

This covers India's IT Rules 2026 (synthetically generated information) and ASCI's AI-labelling
guidelines, which take effect around mid-December 2026.

**Never use** AI-generated "farmer testimonials", AI people or AI-rendered yield results in any
form. ASCI prohibits them even when they're labelled.

---

## What we measure

| Platform | Main metrics |
|---|---|
| YouTube | Engaged views, average % watched, subscribers gained |
| Instagram | Shares and saves per reach, average watch time, skip rate |
| Facebook | `post_video_followers` (follows gained from the Reel), plays, average watch time |
| All three | A daily follower snapshot |

- Metrics are collected at 24 h, 48 h and 7 days.
- Platform analytics lag by up to 48–72 hours, so a video's first-day numbers aren't final.
- Instagram gives no per-Reel follow count, and its account-level follower insights need 100+ followers. Until then, the daily follower snapshot is the growth signal.
- **Weekly report:** every Sunday on Telegram. It proposes series-weight changes, which you apply with one tap. Weights come only from comparing raw values; YouTube's policy restricts derived metrics.

### Honest 30-day expectations

- **"Trending in 30 days" can't be promised.** In vidIQ's study of 367,000 new Shorts channels, the typical Short had about **1,300 views after 30 days** and didn't improve over the first 10 uploads. Only about 21% of Shorts reached 10,000 views.
- No source gives follower benchmarks for new Indian agri accounts, so week-4 targets come from our own **week-1 baseline**.
- What does work, judging by Marathi agri channels growing in October 2026:
  - **consistency** (two useful videos every day);
  - **timely topics** (drought relief, procurement, MSP);
  - **one or two breakout videos**. A drought-relief video on Agrowon got 9.7× its normal views.
- A realistic month-1 aim:
  - 55–60 videos on time with zero factual corrections;
  - steady week-over-week growth in engaged views and shares;
  - at least one video well above the channel's median.

---

## Where the video clips come from

Ranked:

1. **Data graphics we generate.** Price and MSP bars, trend arrows, deadline countdowns, document checklists and step cards. They're always on topic and unique, and they carry no licence risk. They make up most of every video.
2. **Our own brand illustrations.**
   - The source is about 40 flat-vector crop, scene, scheme and machinery images, allow-listed in `config/brand.yaml` and taken from `docs/branding/masters`.
   - They're animated with pan and zoom.
   - Never the SYMPTOM, SCOUT or SEV sets, which are diagnosis art.
3. **Pexels portrait B-roll** (from M3).
   - It's free for commercial use and credited in the description.
   - Generic clips only: soil, water, sky, hands, sprouts.
   - It's limited to 40% of a video's runtime.
   - A vision check screens every clip for non-Indian scenes, identifiable people and logos.
   - Never used as "proof" of a crop or disease.
4. **App screen recordings** from the emulator, made on demand. Only once the app is public.
5. **Best upgrades later:**
   - **A single 1–2 hour phone shoot** (50–100 vertical clips of real fields, mandis and hands at work). This would be the biggest quality jump.
   - Clips from partner Krushi Seva Kendras or farmers, but only after a written-consent flow exists.
   - A paid stock library such as Storyblocks.
   - AI B-roll (for example Veo 3.1 Lite, $0.05–0.08 per second), always disclosed as AI, and never for disease, pests or labels.

### Never use

- **Other creators' or TV channels' clips** (DD Kisan, Agrowon and others), even with our subtitles added. Instagram counts that as unoriginal.
- **yt-dlp** or any other downloader.
- **Anything farmers upload to the app**, including crop-scan photos. The app's privacy policy and terms don't allow it.
- **AI-generated disease or pest images.**
- **The Pixabay API.** Its terms forbid automation.
- **YouTube Audio Library music** on Instagram or Facebook.

---

## Optional human extras that speed up growth

None of these are ever required. Each one helps more than any pipeline change.

- **You or an agronomist on camera** once a week. Face-led Marathi agri channels are growing fastest right now.
- **Sharing** each good video to your Krushi Seva Kendra network and village WhatsApp groups.
- **Collaborations** with Marathi agri creators.
- **Replying to comments** in Marathi in the first hour after a post.
