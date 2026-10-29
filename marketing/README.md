# ksm: KrushiSarva marketing autopilot

ksm makes **two Marathi farmer videos a day** and sends each one to your phone on Telegram. It
publishes to KrushiSarva's YouTube, Instagram and Facebook **only after you tap ✅**. Apart from
that tap, nothing needs a human.

- **Where it runs:** a small Python 3.12 service on your Mac, run by launchd (a background
  LaunchAgent). There's no server and no Railway.
- **What it calls:** Google Gemini on the free tier (script and fact-check), Sarvam (AI voice),
  ffmpeg-full (render), Telegram (approval) and the YouTube and Meta APIs (publishing).
- **What it costs:** about ₹150 a month, all of it for the Sarvam voice. Gemini's free tier costs
  nothing. The hard cap stays at ₹1,500.
- **Where it stands:** milestone M1 is the mandi series, morning slot, YouTube only.
  `config/settings.yaml` ships with `dry_run: true`.

| Doc | What's in it |
|---|---|
| [SETUP.md](SETUP.md) | Your one-time setup checklist: accounts, keys, Mac, day 0 |
| [STRATEGY.md](STRATEGY.md) | Series, schedule, format, safety rules, AI disclosure, KPIs, where clips come from |
| [PRIVACY.md](PRIVACY.md) | The publisher privacy notice (source for the Google Sites page) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Module contracts, for whoever changes the code |

---

## How it works

```
evening/afternoon (Mac awake) ─► plan slot ─► fetch data ─► Gemini script (JSON) ─► checks ─► Sarvam voice
   ─► render (ffmpeg-full + ASS captions) ─► QA ─► Telegram card to your phone
you tap ✅ ─► YouTube: private + publishAt(slot)   Facebook: SCHEDULED(slot)   ← post at the slot even if the Mac is asleep
            Instagram: container created ≤20 h before the slot → published at the slot when the Mac is awake (or on first wake before the cut-off)
next days ─► metrics at 24 h / 48 h / 7 d, daily follower snapshots, Sunday report
```

- **The background agent** reconciles every 60 seconds and immediately when the Mac wakes. It detects sleep from the gap between the wall clock and the monotonic clock.
- **Crash safety:** every publish follows "record intent → call → record result", so a crash or sleep mid-upload never causes a duplicate post.
- **Checks block publishing.** The deterministic checks (numbers, chemicals, rules, length limits) always run before Gemini's fact-check, and a failed check stops the video.
- **All state lives outside the repo,** in `~/Library/Application Support/ks-marketing/`: the SQLite DB, renders, cache and logs. macOS blocks background processes from reading `~/Desktop`.

---

## Your day

| When | What arrives on Telegram | What you do |
|---|---|---|
| ~20:30–22:00 | The card for **tomorrow's 07:00** बाजारभाव video | Watch, read, tap ✅ before bed (hard cut-off 06:45) |
| Daytime, from ~09:00 | The card for **today's 19:00** evening video | Tap ✅ by 18:45 |
| After a tap | The card's caption changes to show progress, then the links | Nothing |
| Sunday | The weekly report, with proposed series-weight changes | One tap to apply, or ignore |
| Any time | Alerts: failures, token problems, missed slots, low disk | See Troubleshooting |

**Each card is two messages:**
1. **A preview video** (720p). Its caption shows the series, hook, slot, platforms, QA result and cost.
2. **A details message:**
   - the channel, Page and handle;
   - the YouTube title, description and visibility;
   - the Instagram and Facebook captions and hashtags;
   - **every claim with its source and date**;
   - the AI flags and the chemical-screen result.

**Buttons:**

| Button | Does |
|---|---|
| ✅ मंजूर | Approve. Posts at the slot time |
| ⚡ आत्ताच | Post now |
| 🧩 प्लॅटफॉर्म | Choose platforms for this video |
| ✏️ बदल | Edit the title, captions or schedule (needs a new ✅ afterwards) |
| 🔄 पुन्हा | Redo, with a reason (up to 2 redos) |
| ⏭ वगळा | Skip. The slot uses an approved evergreen video if one is available |

**How approvals work:**
- Only your Telegram ID can use the buttons.
- An approval covers that exact video and its metadata. Any edit needs a new tap.
- **Nothing is ever published without your tap.**

**If you don't tap:**
- A time-sensitive video expires and the slot is marked missed. Missed slots are never backfilled.
- An evergreen video stays in the buffer for a later slot.
- Telegram keeps button taps for only 24 hours, so a card older than about 20 hours is replaced with a fresh one.

---

## Commands

Activate the venv first: `cd ~/Desktop/KrushiSarva/marketing && source .venv/bin/activate`.

| Command | What it does |
|---|---|
| `ksm install --load` | Copies code, config, fonts and brand art to `~/Library/Application Support/ks-marketing/`, then installs and loads the LaunchAgent. **Re-run after every `git pull` or config edit.** |
| `ksm doctor [--live]` | Health check. Covers ffmpeg libass, fonts, Keychain, disk, memory and agent state. `--live` also calls Telegram, YouTube, Meta, data.gov.in, Sarvam and Gemini (or Anthropic, if `llm.provider` is `anthropic`). |
| `ksm day0 --yes` | One-time live tests that make **real test posts** (see SETUP.md §11). |
| `ksm secrets set <name>` | Stores a secret in the Keychain. Names: `gemini_api_key`, `sarvam_api_key`, `datagov_api_key`, `pexels_api_key`, `telegram_bot_token`, `youtube_client_json`, `meta_system_user_token`, and `anthropic_api_key` (only needed when `llm.provider` is `anthropic`). Short aliases work too (`gemini`, `anthropic`, `meta`, …). |
| `ksm auth-youtube` | One-time Google consent. Stores the YouTube refresh token. Run it as the channel owner. |
| `ksm pair-telegram` | Ties the bot to your Telegram ID (send `/start <code>`). |
| `ksm tick` | Runs one reconcile pass by hand (the agent does this every 60 s). |
| `ksm daemon` | The agent's main loop. launchd runs it; **don't** also run it in a terminal (see Troubleshooting). |
| `ksm dryrun` | Runs the pipeline with publishers that only log. |
| `ksm report` | Prints the cost, slot and metrics report. |
| `ksm purge` | Deletes old renders, previews and cache now, by the retention rules. |
| `ksm render-sample` | Renders a sample video (golden Marathi text check). |

**Settings you may change** (in `config/settings.yaml`, then `ksm install --load`):
- `dry_run`: start with `true`; set `false` to go live.
- `platforms`: `["yt"]` in M1; add `"fb"` and `"ig"` after the Meta day-0 checks.
- `app_cta_url`: stays empty until the Play listing is live. No download call to action is generated without it.
- `budget.monthly_inr`: the spend cap.
- `llm.provider`: the AI that writes and fact-checks scripts. `gemini` (Google, free tier) is the
  default. `anthropic` switches back to Claude, which is paid (about ₹1,250 a month more) and needs
  `anthropic_api_key`. If you switch, also update PRIVACY.md and the Google Sites page, which name
  Google as the script service.
- `llm.model`: the model name for that provider. Default: `gemini-3.6-flash`.
- The effort settings in the `claude:` block apply to both providers.

Secrets are never in files.

---

## Troubleshooting

Logs are in `~/Library/Application Support/ks-marketing/logs/`. When in doubt, start with
`ksm doctor --live`.

**Telegram is silent (no cards, no alerts)**
1. Check that the agent is running: `launchctl print gui/$(id -u)/com.krushisarva.marketing | grep state`. It should say `running`. If it doesn't, run `ksm install --load`.
2. Restart it: `launchctl kickstart -k gui/$(id -u)/com.krushisarva.marketing`.
3. Make sure no second copy is polling the same bot, such as `ksm daemon` left running in a terminal. Telegram allows only one poller per bot token, and the other one steals the updates.
4. Run `ksm doctor --live`.
   - If Telegram `getMe` fails, the token is wrong or was revoked. Get it from @BotFather and run `ksm secrets set telegram_bot_token` again.
5. Is the Mac asleep, or are you logged out? See "The Mac was asleep".
6. Check your budget with `ksm report`. Once the monthly cap is reached, only already-approved videos are published and no new cards are made.

**A token expired**
- **YouTube** (`invalid_grant` alert):
  1. Run `ksm auth-youtube` again as krushisarva@gmail.com.
  2. If it keeps happening weekly, the Google consent screen is still in **Testing**. Publish it (SETUP.md §6), then re-authorise.
  - A token also dies if it isn't used for 6 months, if access is revoked at security.google.com, or if you chose time-limited access on the consent screen. When you re-authorise, choose the option with no end date.
- **Meta** (error 190, or `debug_token` fails):
  1. In Business settings → System users → `ksm-publisher`, generate a new never-expiring token with the same nine permissions (SETUP.md §7).
  2. Run `ksm secrets set meta_system_user_token`.
  - Changing the Page or Instagram assignment can invalidate the old token.
- After fixing either, run `ksm doctor --live`.

**Disk is low**
- **Thresholds:**
  - below **5 GB** free, production stops (approved videos still publish);
  - below **3 GB**, old files are purged automatically.
- **Normal retention:**
  - working files are deleted after QA;
  - previews 1 day after your decision;
  - masters 3 days after every platform has published.
- **Fix:**
  1. Run `ksm purge`.
  2. Check `du -sh ~/Library/Application\ Support/ks-marketing/*`.
  3. Free space elsewhere (SETUP.md §1).

  Production resumes on its own.

**The Mac was asleep**
- **What still happens:**
  - Approved YouTube and Facebook posts still go out on time, because they were scheduled on the platform at approval.
  - Instagram posts only while the Mac is awake. A late post goes out until the cut-off: 10:00 for the morning slot, 21:30 for the evening slot, and never during 22:30–05:30.
  - After the cut-off, time-sensitive videos are skipped on Instagram, and evergreen videos move to the next free slot.
- **On wake:**
  - missed slots are marked missed and never backfilled;
  - stale videos expire;
  - cards older than about 20 hours are re-sent.
- **Prevent it:**
  - check the energy settings (SETUP.md §10);
  - keep the Mac on the charger with the lid open;
  - optionally schedule a wake with `pmset`.

**A video failed a check**
- The card or alert names the check. You can:
  - tap 🔄 पुन्हा with a reason;
  - or skip it with ⏭.
- Never work around the numbers or chemicals check. It exists so that no wrong price or pesticide advice reaches farmers.

**Rendering is waiting**
- Rendering pauses while the Android emulator runs or macOS reports memory pressure. It resumes on its own.

**The scheme series won't run**
- The योजना अपडेट series (milestone M3) fact-checks with web search, and that only works on Claude
  for now. On Gemini it stops with a config error.
- Leave it disabled, or set `llm.provider: anthropic` (paid) and run `ksm install --load`.

---

## File layout

```
marketing/
  README.md  SETUP.md  STRATEGY.md  PRIVACY.md
  pyproject.toml  requirements.lock  requirements-dev.lock
  config/      settings.yaml series.yaml calendar.yaml msp.yaml advisories.yaml markets_mr.yaml
               crops_mr.yaml sources_allowlist.yaml pronunciation.yaml brand.yaml hashtags.yaml
  assets/      fonts/ (Mukta, Baloo 2, Noto Sans Devanagari + OFL)   brand/ (watermark, header)
  launchd/     com.krushisarva.marketing.plist.tmpl
  docs/        ARCHITECTURE.md (module contracts)
  scripts/     sync_registry.py (refreshes the chemical registry snapshot)
  src/ksm/     cli config paths clock db+migrations secrets ledger guards
               daemon reconcile statemachine planner
               sources/  agmarknet msp advisories calendar pexels
               writer/   claude gemini schemas prompts/
               checks/   numbers chemicals rules factcheck limits marathi
               voice/    sarvam timeline
               render/   layout cards ass ffmpeg qa vision_qa
               approve/  telegram cards callbacks
               publish/  common youtube meta_fb meta_ig
               metrics/  collect report
  tests/       unit/ golden/ live/ fixtures/
```

**Runtime state** (never in git) lives in `~/Library/Application Support/ks-marketing/`:
- `ksm.db`
- `config/` and `assets/` (installed copies)
- `work/`, `renders/`, `cache/` and `logs/`

Set `KSM_HOME` to point it elsewhere, which is useful in tests.

---

## Development

```sh
cd ~/Desktop/KrushiSarva/marketing
/opt/homebrew/bin/python3.12 -m venv .venv
.venv/bin/pip install -r requirements-dev.lock && .venv/bin/pip install -e . --no-deps
.venv/bin/python -m pytest -m "not render and not live"   # what CI runs (hermetic)
.venv/bin/python -m pytest -m render                       # needs ffmpeg-full (Mac)
.venv/bin/python -m pytest -m live                         # real APIs and real money; by hand only
```

CI runs the hermetic suite in the `marketing` job of `.github/workflows/ci.yml`.

**Updating dependencies:**
1. Edit `pyproject.toml`.
2. Run `pip install -e '.[dev]'` in a fresh venv.
3. Regenerate both lock files from `pip freeze`:
   - `requirements-dev.lock` = everything;
   - `requirements.lock` = only the closure of `[project].dependencies`.

The lock files hold version pins, not hashes.
