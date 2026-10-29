# ksm — architecture and module contracts

This is the contract every module is built against. Shared types live in
`src/ksm/models.py`; the schema in `src/ksm/migrations/001_init.sql`; settings in
`config/settings.yaml` (`ksm.config.get_settings()`); paths in `ksm.paths`;
time maths in `ksm.clock`; DB helpers in `ksm.db`.

Rules that apply to every module:
- Python 3.12, type hints, no module-level network calls, no secrets in files.
- External HTTP uses `httpx` (sync) with explicit timeouts. The AI writer is provider-specific
  (`llm.provider` in `config/settings.yaml`): Gemini (`gemini`, the default, free tier) goes
  through `writer/gemini.py` over `httpx`; Claude (`anthropic`, paid) uses the official
  `anthropic` SDK (1.x). Every external client is injectable (constructor arg or
  function parameter) so tests run hermetically with fakes or `respx`.
- Secrets come from `ksm.secrets.get_secret(name)` (macOS Keychain via `keyring`,
  service name `ks-marketing`). Names: `gemini_api_key`, `anthropic_api_key` (only when
  `llm.provider` is `anthropic`), `sarvam_api_key`, `datagov_api_key`, `pexels_api_key`,
  `telegram_bot_token`, `youtube_client_json`, `youtube_refresh_token`,
  `meta_system_user_token`.
- Never log secrets. Never write outside `ksm.paths.Paths` locations (tests use `tmp_path`).
- All Devanagari text rendering goes through libass (ASS subtitles) in ffmpeg-full.
  Pillow may only draw text-free graphics (shapes, bars, images).
- Content safety: no pesticide/fertiliser names or doses, no price predictions,
  no instalment/relief dates without an official source, no politicians/parties,
  no income/yield guarantees, no app-download CTA unless `settings.app_cta_url`.

## Module contracts

### sources/
```python
# sources/agmarknet.py
RESOURCE_ID = "9ef84268-d588-465a-a308-a864a43d0070"
@dataclass class MandiRow: commodity: str; variety: str; market: str; district: str; state: str;
                           min_price: float; max_price: float; modal_price: float; arrival_date: date
def parse_row(raw: dict) -> MandiRow | None          # None on bad/missing date (NEVER substitute today),
                                                      # modal not in [min,max], any price <= 0
def fetch_snapshot(client: httpx.Client, api_key: str, state: str = "Maharashtra",
                   page_size: int = 500, max_pages: int = 20) -> list[MandiRow]
def store_snapshot(conn, rows, *, key="Maharashtra") -> list[date]   # groups by arrival_date into data_snapshots (idempotent)
def mandi_payload(conn, data_date: date, *, commodities_cfg: dict, msp: "MspTable",
                  min_markets: int = 3) -> dict | None
    # -> {"data_date": "...", "source": "Agmarknet / data.gov.in, Government of India",
    #     "commodities": [{"key","name_mr","msp","msp_label","markets":[{"market","market_mr","district",
    #       "modal","min","max"}], "median_modal", "vs_msp_pct", "prev_median_modal"|None}], ...}
    # None if fewer than min_markets for every configured commodity.
# sources/msp.py
@dataclass class MspRow: crop: str; season_label: str; variety: str | None; price: int; source_url: str; source_date: str
class MspTable: rows: list[MspRow]; def lookup(crop: str, variety: str | None = None) -> MspRow | None
def load_msp(config_dir) -> MspTable                 # from config/msp.yaml; raises if any row lacks source_url
# sources/advisories.py
def load_advisories(config_dir) -> list[dict]        # config/advisories.yaml entries (each has id, crop, topic, facts[], sources[])
def advisory_payload(entry: dict) -> dict
# sources/calendar.py
def events_between(config_dir, start: date, end: date) -> list[dict]   # config/calendar.yaml
```

### checks/
```python
def check_numbers(script: VideoScript, payload: dict, extra_allowed: set[str] = frozenset()) -> CheckReport
    # every numeral in narration/onscreen/platform text (Latin or Devanagari digits, commas, ₹, %) must
    # appear in the flattened payload values (exact after normalisation) or extra_allowed
    # (e.g. helpline 1800-180-1551, years, the slot date).
def check_chemicals(script: VideoScript) -> CheckReport
    # Latin registry (snapshot of fastapi/safety/chemicals.py in checks/registry_snapshot.json) +
    # Devanagari lexicon (pesticide class nouns, transliterated actives/brands) + dose regex;
    # chemicals_mentioned_en must be empty. Allowed phrases: 'फवारणी टाळा', 'कृषी अधिकारी', 'KVK'.
def check_rules(script: VideoScript, *, series: str, app_cta_url: str | None) -> CheckReport
    # prediction words, politician/party lexicon, download CTA without url, date claims w/o source_url,
    # wrong Kisan Call Centre number (must be 1800-180-1551).
def check_limits(script: VideoScript) -> CheckReport
    # yt title <=100 chars, yt description <=5000 UTF-8 bytes, yt tags total <=500 chars, hashtags <=5 on ig/fb,
    # ig caption <=2200, no links in fb caption, onscreen lines <=22 graphemes, narration <=750 chars.
def run_deterministic(script, payload, *, series, app_cta_url) -> CheckReport   # all of the above
```

### writer/
```python
# writer/claude.py (shared entry points for both providers)
def structured_call(client, out_type: type[BaseModel], *, settings: Settings, effort: str,
                    what: str, **kw) -> tuple[BaseModel, dict]
    # one structured-output request; dispatches on settings.provider ("gemini" | "anthropic").
    # Usage first (every failure carries the spend), then refusal, then cut-off, then validation.
    # Raises ClaudeRefusal / ClaudeError for both providers.
def write_script(client, *, settings: Settings, series_cfg: dict, plan: VideoPlan,
                 glossary: dict, recent_titles: list[str], feedback: str | None) -> tuple[VideoScript, dict]
    # client = GeminiClient (provider "gemini") or anthropic.Anthropic (provider "anthropic").
    # returns (script, usage) where usage = {"input_tokens","output_tokens","cache_read_input_tokens",
    #  "cache_creation_input_tokens","web_search_requests","cost_inr"}
def factcheck(client, *, settings, plan: VideoPlan, script: VideoScript, web: bool) -> tuple[CheckReport, dict]
    # Marathi QA + claim verification; web tools only when web=True, restricted to config/sources_allowlist.yaml.
    # web=True is Claude-only for now: on Gemini a series that needs it (the M3 scheme series) is a config error.

# writer/gemini.py
class GeminiClient:  # raw httpx, REST v1beta models/{model}:generateContent
    # API key in the x-goog-api-key header (never in the URL); JSON-schema structured output;
    # retries 429 and 5xx; errors reuse ClaudeError / ClaudeRefusal so callers handle both providers alike.
```
The `claude:` block's effort settings (`writer_effort`, `factcheck_effort`) apply to both providers.
Prompts are versioned files in `writer/prompts/` (`writer.v1.md`, `factcheck.v1.md`, `series_*.v1.md`).

### voice/
```python
def split_sentences(text: str) -> list[str]           # port of _nextVoiceSentence (never split inside numbers)
class SarvamTTS:
    def __init__(self, api_key: str, client: httpx.Client | None = None, *, model="bulbul:v4-flash",
                 speaker="mrunal_mr_narration", sample_rate=48000, dict_id: str | None = None)
    def synth(self, text: str) -> bytes                # WAV bytes
def synthesize(script: VideoScript, tts: SarvamTTS, out_dir: Path, gap_s: float = 0.18) -> Timeline
def chunk_captions(sentence: str, duration_s: float, start_s: float,
                   max_graphemes: int = 22, min_chunk_s: float = 0.6) -> list[tuple[float, float, str]]
```

### render/
```python
SAFE = dict(x0=70, x1=880, y0=380, y1=1250)          # layout.py
def build_cards(script, plan, out_dir, assets_dir) -> list[Path]      # cards.py, Pillow, TEXT-FREE, 1080x1920
def build_ass(script, timeline, plan, fonts) -> str                   # ass.py, styles Hook/Caption/Label/Tag/Source/EndCard
def ffmpeg_bin() -> str                                               # ffmpeg.py: prefers /opt/homebrew/opt/ffmpeg-full/bin/ffmpeg
def render_command(cards, timeline, ass_path, out_master, *, fonts_dir, watermark) -> list[str]
def render(script, timeline, plan, work_dir, out_dir, *, assets_dir) -> RenderOutputs
def probe(master: Path) -> QAReport                                   # qa.py: ffprobe/ebur128/blackdetect checks
```

### approve/
```python
class TelegramClient:  # raw httpx Bot API
    def __init__(self, token: str, client: httpx.Client | None = None)
    def get_updates(self, offset: int | None, timeout: int = 50) -> list[dict]
    def send_video(self, chat_id, path: Path, caption: str, reply_markup: dict | None) -> int
    def send_message(self, chat_id, text: str, reply_markup: dict | None = None, parse_mode="HTML") -> int
    def edit_caption(...); def edit_reply_markup(...); def answer_callback(callback_id, text="")
def card_texts(revision_row, video_row, slot_row, settings) -> tuple[str, str]   # (video caption <=1024, details <=4096)
def keyboard(approval_id: int, nonce: str, platforms: list[str]) -> dict
def parse_callback(data: str) -> tuple[str, int, str] | None                     # 'act:id:nonce' -> (act, id, nonce)
def handle_update(conn, update: dict, *, owner_id: int) -> Decision | None       # owner-only, nonce check, dedupe
```

### publish/
```python
class Publisher(Protocol):
    platform: str
    def ensure(self, conn, pub_row, revision_row, *, now: datetime) -> str   # returns new PubState; idempotent
# youtube.py: resumable upload (persist session URI before sending bytes), hidden tag ksv-<video>-<rev>,
#   recovery via session status query, then uploads-playlist scan for the tag; status sent explicitly.
# meta_fb.py: video_reels start (persist video_id) -> rupload bytes -> finish SCHEDULED/PUBLISHED.
# meta_ig.py: container upload_type=resumable (persist id) -> rupload bytes -> poll FINISHED ->
#   media_publish when due; content_publishing_limit check; recover PUBLISHED containers.
# common.py: record_intent / record_result helpers, retry/backoff, dry-run wrapper.
GRAPH_VERSION = "v26.0"
```

### core
- `secrets.py`: `get_secret(name) -> str`, `set_secret(name, value)`, `has_secret(name)`.
- `ledger.py`: `record(conn, provider, op, cost_inr, video_id=None, **units)`, `month_spend(conn, month) -> float`,
  `budget_state(conn, settings) -> "ok"|"warn"|"degraded"|"exhausted"`, price helpers for Claude & Sarvam.
- `guards.py`: `free_disk_gb()`, `memory_pressure_level()`, `emulator_running()`, `check(conn, settings) -> GuardState`.
- `planner.py`: `plan_slot(conn, slot, now, settings) -> VideoPlan | None`.
- `statemachine.py`: `advance(conn, video_id, deps, now)` — runs exactly one step for a video.
- `reconcile.py`: `tick(conn, deps, now, woke: bool)` — see plan §4.
- `daemon.py`: main loop + Telegram poller thread; `cli.py`: `ksm` commands (install, doctor, daemon, tick,
  day0, dryrun, pair-telegram, auth-youtube, secrets, purge, report, render-sample).
