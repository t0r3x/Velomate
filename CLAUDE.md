# Velomate — Project Reference

> Cycling training dashboard with Garmin Connect integration and AI-driven adaptive training plans.
> Backend: Express/TypeScript + better-sqlite3 · Frontend: Vue 3 + Pinia + Vue Router + Vite · Desktop shell: Electron (auto-updates via GitHub Releases) · DB: SQLite

---

## Running the project

```bash
# From repo root
npm run install-all       # install frontend + backend deps
npm run dev                # backend (ts-node + nodemon, :2012) + frontend (vite, :5173) concurrently
npm run build               # build frontend (vue-tsc + vite) then backend (tsc → dist/)
npm start                   # run built backend only (serves frontend/dist as static files)

npm run electron:dev        # build backend, then launch frontend dev server + Electron shell together
npm run electron:build      # build everything, package installers (dist-electron/), no publish
npm run electron:publish    # same, but uploads installers as a GitHub Release (needs GH_TOKEN, repo scope)
npm run electron:rebuild    # rebuild better-sqlite3's native binding against Electron's Node ABI
```

In dev, backend and frontend run as separate processes (frontend on :5173 proxies API calls to :2012). In a build (Docker, Node-only, or packaged Electron), Express serves the compiled Vue app directly:
```typescript
app.use(express.static(path.join(__dirname, '../../frontend/dist')));
```
Backend port: `process.env.PORT || 2012` (not 3001 — legacy).

---

## Directory layout

```
velomate/
├── electron-main.js              ← Electron main process entry (see "Electron desktop shell" below)
├── electron/preload.js           ← contextBridge: window controls + update IPC → window.electronAPI
├── electron-builder.yml          ← packaging + GitHub Releases publish/update-feed config
├── backend/
│   ├── src/
│   │   ├── server.ts                  ← Express app + all API routes + runGeminiAutoCheck()
│   │   ├── types.ts                   ← UserHRProfile, HeartRateZone
│   │   ├── logger.ts                  ← Winston + daily rotation (LOG_DIR / LOG_LEVEL)
│   │   ├── utils.ts                   ← localDate(), APP_NAME
│   │   └── services/
│   │       ├── database.service.ts    ← SQLite CRUD (better-sqlite3, sync) + PlanEntry/WorkoutStep types
│   │       ├── gemini.service.ts      ← Gemini API, prompt building, auto-skip detection, parseZones()
│   │       ├── activity.service.ts    ← Garmin activity fetch + Garmin data mapping
│   │       ├── garmin.service.ts      ← OAuth2/session management
│   │       ├── sso.service.ts         ← Garmin SSO login flow + MFA
│   │       ├── profile.service.ts     ← HR profile calc + config.json fallback
│   │       └── workout.service.ts     ← Garmin workout upload + schedule
│   └── config.json                    ← HR profile fallback (legacy, still read/written for backward compat)
└── frontend/
    ├── src/
    │   ├── main.ts                    ← createApp + Pinia + router
    │   ├── App.vue                    ← TitleBar, UpdateBanner, <router-view/>, global dialogs/toasts
    │   ├── types.ts                   ← frontend-side types (mirrors backend + API response shapes)
    │   ├── router/                    ← 3 routes + beforeEach auth/setup guard (replaces old setView())
    │   ├── stores/                    ← Pinia: auth, settings, profile, activities, recommendation
    │   ├── views/                     ← SetupView, ProfileSetupView, DashboardView
    │   ├── components/                ← layout/, activities/, profile/, recommendation/, ui/
    │   ├── composables/                ← useTimeAgo, useUpdater, useToast, useConfirm, useZones, dialogs
    │   └── utils/electron.ts          ← isElectron(), electronAPI() wrapper
    └── dist/                          ← vite build output, served by Express in prod/packaged builds
```

SQLite DB location (not `backend/data/` by default anymore — see gotcha #1):
- Dev / Docker: `VELOMATE_DB_PATH` env var if set, else `backend/data/velomate.db`
- Packaged Electron: OS user-data dir (`%APPDATA%\velomate\` on Windows, `~/.velomate` elsewhere)

---

## Database schema (better-sqlite3, synchronous, WAL mode)

Zone data is stored as **flat min/max or seconds columns**, not JSON blobs (a prior schema used JSON columns; a one-time startup migration drops and recreates the affected tables if it detects the old shape).

```sql
activities    -- Garmin cycling activities (upsert by activityId)
  activityId TEXT PK, name, type, startTime, distanceKm REAL, durationMinutes INTEGER,
  averageHr, maxHr, averagePower, maxPower INTEGER,
  z1Sec, z2Sec, z3Sec, z4Sec, z5Sec INTEGER,          -- seconds per zone, nullable
  perceivedExertion INTEGER, feelingAfterExercise INTEGER,  -- 0-100 Garmin scale, filled in separately
  fetchedAt TEXT

analysis      -- id=1 singleton: computed stats over last 90 days
  id=1, totalCyclingRides, maxRecordedHr, estimatedMaxHr, estimatedLthr, averageRideDurationMinutes,
  z1min/z1max .. z5min/z5max INTEGER, updatedAt

profile       -- id=1 singleton: user HR profile
  id=1, maxHr, lthr,
  z1min/z1max .. z5min/z5max INTEGER, hasCustomOverrides INTEGER, lastUpdated

settings      -- key/value store (generic — see "Settings stored in DB" below for the full key list)
  key TEXT PK, value TEXT

daily_checkin -- how the athlete feels on a day, with or without a ride (see "Daily check-in")
  date TEXT PK (YYYY-MM-DD local), feeling INTEGER (1-5), note TEXT, createdAt, updatedAt

free_suggestion -- free training mode: one dateless "next workout" per row (see below)
  id INTEGER PK AUTOINCREMENT, workoutType, reason, priority, coachNote TEXT,
  structure TEXT (JSON WorkoutStructure | null), loadAssessment TEXT (JSON),
  status TEXT ('open'|'synced'|'completed'|'dismissed'|'superseded'),
  generatedAt, syncedAt, syncedForDate, completedDate, completedActivityId TEXT,
  executionScore INTEGER, executionNote TEXT

recommendation -- id=1 singleton: current AI training plan
  id=1, workoutType, reason, priority TEXT,
  weeklyPlan TEXT (JSON PlanEntry[14], entries carry executionScore/executionNote),
  nextWeekOverview TEXT (legacy, unused — see below), nextWeekFocus TEXT,
  changeNote TEXT, changedEntries TEXT (JSON PlanChange[]),  -- see "Showing its working"
  loadAssessment TEXT (JSON), generatedAt TEXT
```

**The `devices` table is gone** — it was dead code (no reads/writes, no route) and was dropped along with `GET/POST /api/devices*`.

**`nextWeekOverview` is legacy/unused** — the forward `weeklyPlan` window is 14 real days (previously 7, with a separate AI-guessed `nextWeekOverview` summary `{summary, sessions[], emphasis}` standing in for the second week). Now that the second week is real planned data, that guess was redundant and was removed from the prompt/schema and the frontend. The DB column still exists so old rows keep parsing, but `upsertRecommendation()` always writes `NULL` to it — don't resurrect it.

**`nextWeekFocus` (TEXT, nullable) replaces the "why" part of the old `nextWeekOverview`** — a 1-2 sentence AI-written rationale for the training theme of the second week (`weeklyPlan[7..13]`) as a whole, e.g. "Introduce structured Tempo intervals to build fatigue resistance while keeping overall volume low." Unlike the old `nextWeekOverview`, this isn't a forward guess — it's generated in the same call as the real days it describes, so it explains decisions already made rather than speculating. Added via an idempotent `ALTER TABLE ... ADD COLUMN` migration (`hasColumn()` check in `database.service.ts`) since existing `recommendation` rows must be preserved, unlike the disposable zone/`devices` migrations above.

`perceivedExertion`/`feelingAfterExercise` are populated by a separate per-activity detail fetch and are **excluded from the bulk-upsert `ON CONFLICT` clause** so a routine activity-list sync never clobbers them.

---

## Key types

```typescript
// backend/src/services/database.service.ts
interface PlanEntry {
  date: string;           // YYYY-MM-DD
  type: string;           // Sprint | VO2Max | Threshold | Tempo | LongRide | Rest
  reason: string;
  status: 'planned' | 'completed' | 'skipped' | 'auto-skipped';
  structure?: WorkoutStructure | null;
  executionScore?: number | null;   // 0-100, AI-generated
  executionNote?: string | null;    // 1-sentence AI explanation of the score
}

interface WorkoutStep {
  stepType: 'WarmUp' | 'Run' | 'Recovery' | 'Cooldown';
  durationSec: number;
  zone: 'z1' | 'z2' | 'z3' | 'z4' | 'z5';
  label: string;
}
```

Note: `frontend/src/types.ts`'s `PlanEntryStatus` additionally declares `'completed-partial' | 'completed-mismatch'`, which the backend type doesn't — a minor pre-existing type drift, not currently exercised (backend only ever writes the 4 statuses above).

---

## Execution scoring (AI-driven, not rule-based)

There is **no `classifyExecution()` function** — that rule-based Sprint/Threshold/LongRide thresholding was removed. Completion is now determined in two separate steps:

1. **Binary match** (`classifyCompletedEntries()` in `gemini.service.ts`): any planned **non-Rest** entry with a Garmin activity on that date → `'completed'`. Tie-break: an activity named "Velomate" wins, else the longest ride of the day. **Rest is excluded deliberately** — riding on a rest day does not complete it, and marking it so would hand the AI a `Rest → NEEDS SCORING` line the rubric has no band for. A past Rest day therefore stays `'planned'` forever, which is what the rolling-history logic below already assumes; the ride itself still reaches the model via `RECENT ACTIVITIES`.
2. **Quality scoring**: delegated entirely to the AI. `executionScore` (0-100) and `executionNote` come back from the *same* Gemini call that regenerates the weekly plan, using a rubric embedded in the prompt (90-100 textbook / 75-89 good / 60-74 partial / 40-59 poor / 0-39 mismatch), based on zone data + RPE + feeling.

`parseZones()` in `gemini.service.ts` guards malformed zone arrays before they're formatted into the prompt:
```ts
const parseZones = (raw: any): number[] | null => Array.isArray(raw) && raw.length >= 5 ? raw : null;
```

---

## AI / Gemini integration

### Key invariant
The **first plan** is ONLY generated when the user explicitly clicks **"Generate my first plan"** on the `no-plan` recommendation state.

### Auto-check (`runGeminiAutoCheck()` in `server.ts`, not in `gemini.service.ts`)
Runs once at startup, then `setInterval(..., 60 * 60 * 1000)` (hourly):
1. No API key, or training paused → skip
2. Sync activities, detect auto-skips (`detectAutoSkippedEntries()`, excludes dates inside a completed pause window) → regenerate if any found. Also detects newly-completed rides (a `planned` entry that flipped to `completed` during this sync, same logic as `/api/activities/refresh`) and regenerates for that too — but only when `instant_score_on_new_activity` is enabled (default on)
3. Auto-pause training after `inactivityPauseDays` (default 14, user-configurable) consecutive days with no completed workout
4. Otherwise regenerate only if plan is >23h stale
5. On Gemini 429 → stamp `gemini_last_generated` to back off for 23h

The first plan is never created here — only steps 2-4 ever fire, and they all require an existing plan.

### Instant execution scoring (`instant_score_on_new_activity` setting)
`executionScore`/`executionNote` are only produced by a full `generateRecommendation()` call (there's no standalone scoring function — see "Execution scoring" above). Both activity-sync paths — the manual `POST /api/activities/refresh` and the hourly `runGeminiAutoCheck()` — detect newly-completed rides (a `planned` entry that just flipped to `completed`) and, when `instant_score_on_new_activity` is enabled (default **on**), immediately trigger a regen so the score shows up right away instead of waiting for the next 23h-staleness regen. Turning it off saves AI calls at the cost of a delayed score.

### `generateRecommendation(previousPlan?, pauseContext?, pinnedTodayType?)`
- Retries with a shrinking activity window (`ACTIVITY_WINDOWS = [21, 14, 10]` days) if Gemini's response is truncated (`finishReason === 'MAX_TOKENS'`)
- POSTs to `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`, retries up to 3× on HTTP 429 with backoff
- `responseMimeType: "application/json"`, joins all parts: `parts.map(p => p.text ?? '').join('')` — avoids truncation
- `temperature: 0.2`. Deliberately low: the prompt asks for plan stability in prose, and a higher setting sampled against the very thing it was asking for.
- **Single-flight**: `generateRecommendation()` is a thin wrapper around `_generatePlan()` guarded by a module-level `planGenerationInFlight` promise — a second concurrent caller joins the run already in progress instead of starting its own. Six paths can trigger a generation and most fire without awaiting (an ordinary app launch triggers two), so without this, two Gemini calls would race to write `recommendation.id=1`. `generateFreeSuggestion()` has the same guard (`freeGenerationInFlight`); `isGenerationInFlight()` exposes both to the API.
- Only `weeklyPlan[0..6]` get a `structure` (`STRUCTURED_WINDOW_DAYS`); days 7-13 are a typed outline with `structure: null`. Only the first week is ever synced to Garmin (`syncAndScheduleWorkouts` covers today..today+6) and the plan regenerates daily, so a second-week day always gets its structure before it can be ridden. Generating them up front was roughly half the output tokens, thrown away — and the main cause of the `MAX_TOKENS` truncation the `ACTIVITY_WINDOWS` ladder exists to retry around. Don't "restore" it.
- Validates: `today.type` in the valid set, `weeklyPlan` is exactly 14 entries (`PLAN_WINDOW_DAYS`)
- Merges statuses/scores from the plan **as stored at write time** (`getStoredRecommendation()` re-read inside `_attemptGeneration`), not from the `previousPlan` argument — that argument is only the prompt's view of the world. The Gemini round trip takes many seconds, and a skip, reschedule or completion committed during it would otherwise be clobbered by the opening snapshot. Never re-scores an already-scored entry; keeps a rolling 14-day window of ALL past entries (any status — completed, skipped, auto-skipped, or still-planned Rest days) prepended to the new 14-day window. This must NOT be filtered to `status === 'completed'` only — Rest days never reach 'completed' (no Garmin activity to match), so that filter would silently drop every past Rest day, which is invisible with a rolling "today onwards" display but breaks a fixed calendar-week display that renders days before today.
- Recomputes `structure.totalMinutes` from steps (corrects AI rounding)
- Always returns `getStoredRecommendation()` (i.e., what was just saved to DB)

### Showing its working: `changeNote` + `changedEntries`

A plan that rearranges itself in response to a check-in is only trustworthy if the athlete can see what
moved and why. Without that, daily adaptation — the entire point of the app — reads as the thing being
erratic. So every regeneration records both.

- **`changedEntries` is computed, never asked of the model.** `diffPlans(statusSource, weeklyPlan)`
  compares the new forward window against the plan as the athlete last saw it. Three exclusions, all
  load-bearing: days **before today** (cannot be acted on), days whose previous status was not
  `'planned'` (a `planned → completed` flip is something the athlete did, not a change of plan), and
  days whose type is unchanged.
- **`changeNote` is the model's reason**, and the only part it supplies. It sits **after `weeklyPlan`**
  in the output key order — it describes a plan already written, so it can only be honest once that
  plan exists. The prompt tells the model the athlete sees the exact list of changed days next to it,
  so an invented change is visible as a lie.
- `PlanChanges.vue` renders the computed list first and the note underneath, for the same reason.
  It renders nothing at all when both are empty, which is the first-plan case — there is no previous
  version to differ from.

### Prompt structure: static `systemInstruction` + dynamic athlete turn

Each mode has **two halves**, and which half a piece of text belongs in is a real decision, not formatting:

- `PLAN_SYSTEM_INSTRUCTION` / `FREE_SYSTEM_INSTRUCTION` — module constants, byte-identical on every call: role, `ACTIVITY_DATA_NOTES`, `WORKOUT_TYPE_GUIDELINES`, `CALIBRATION_GUIDELINES`, `SCORING_RUBRIC`, the output schema and the STRICT RULES. Sent as `systemInstruction`, where Gemini adheres to them more reliably than to the same text buried in a long user turn, and where — being identical every time — they form a cacheable prefix. Roughly 10.8k of the plan prompt's ~13.4k characters live here.
- `buildPrompt()` / `buildFreePrompt()` — only this athlete, today (~2.6k chars).

**Never move a static block into the per-call turn to interpolate one value into it.** That forfeits both the adherence and the caching for the sake of a detail that belongs in the athlete data. Cross-references in the static half must name the block they point at ("in the PREVIOUS PLAN COMPLIANCE block"), never "above" — the two halves are separate messages.

**Output key order is load-bearing**, not cosmetic: `executionScores` → `loadAssessment` → `today` → `weeklyPlan` → `nextWeekFocus`. Generation is autoregressive, so later fields are conditioned on earlier ones. `loadAssessment` used to come *last*, which meant the model wrote fourteen days of plan and only then stated the fatigue judgement supposedly driving it — a rationalisation after the fact. Scores (evidence) → assessment (judgement) → plan (consequence) is the order the STRICT RULES now spell out as mandatory. Parsing is by key and unaffected; this is purely about what the model conditions on.

### `buildPrompt()` assembles
today's date/day-of-week, athlete preferences (preferred long-ride days, free-text goals), pause context, `buildPreviousAssessmentBlock()`, previous-plan compliance (completed/skipped/auto-skipped with RPE/feeling), pinned-today block, existing scheduled workouts, HR profile/zones, 90-day analysis, `buildTrainingLoadBlock()`, and the last-21-day (or reduced) ride table. The guidelines, rubric, schema and rules are **not** here — they are in the system instruction.

Two blocks exist specifically because the model was previously being asked to derive them itself:

- **`buildTrainingLoadBlock()`** — weekly volume for four rolling 7-day blocks, Z3+ minutes, days since the last hard effort (≥10 min in Z4/Z5), consecutive training days, most recent rideless day. Summing zone minutes across weeks and doing date arithmetic over a ride list are things LLMs get wrong silently, and the answers drive every downstream decision. Two accuracy details that are easy to regress: the rideless-day scan starts at **yesterday** (today is not over, so its lack of a ride proves nothing), and the weekly average covers only the blocks the stored history actually reaches — averaging one real week against three empty ones would report a fraction of the athlete's true load as fact.
- **`buildPreviousAssessmentBlock()`** — the stored `loadAssessment` from the plan being revised. PLAN STABILITY condition (d) ("your loadAssessment differs from PREVIOUS ASSESSMENT") is unevaluable without it; before this block existed, the rule asked the model to compare against something it had never been shown.

Rides are rendered by `formatActivityLines()` as one line per ride (`date | duration | avgHR | distance | zone minutes | rating`), not `JSON.stringify(..., null, 2)` — the column order is documented in `ACTIVITY_DATA_NOTES`, so the two must change together.

### AI model selection

The model is **user-supplied free text**, not a fixed dropdown — that list went stale every time Google
shipped a model. `SettingsPanel.vue` offers `MODEL_PRESETS` (currently `gemini-3.6-flash` and
`gemini-3.5-flash-lite`) plus a `Custom model ID…` option that reveals a text field, which is how Pro-tier
and brand-new models get in. A stored value that is not a preset reopens the form **in custom mode with
that value**, so removing a preset in a later version never silently resets someone's choice.

Three helpers in `gemini.service.ts` own this:
- `normalizeModelId(raw)` — trims, strips the `models/` prefix (Google's docs and ListModels show it, so
  people paste it verbatim), lowercases.
- `isValidModelId(id)` — `/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/`. Lowercase alphanumeric segments joined by dots
  or hyphens, which is the shape of every Gemini/Gemma ID. Deliberately a **format** check, not an
  allowlist: a model released after this build must still be enterable.
- `getGeminiModel()` — the single read path, falling back to `DEFAULT_GEMINI_MODEL` when the stored value
  is missing or no longer valid. Never read `getSetting('gemini_model')` directly.

`POST /api/settings/gemini-model` validates server-side too, and that is **not** duplicate work: the model
is interpolated into the Gemini request path (`/v1beta/models/{model}:generateContent`), so a value
containing `/`, `?` or `..` would rewrite the endpoint rather than name a model. `SettingsPanel.vue`
mirrors the same two functions purely to give an actionable message before the request goes out.

### Settings stored in DB
| Key | Description |
|-----|-------------|
| `gemini_api_key` | Raw API key |
| `gemini_model` | e.g. `gemini-3.6-flash` (default). Free-text: the settings form offers two presets plus a "Custom model ID…" field, so a Pro-tier or newly released model can be used without an app update. Always stored normalized — see "AI model selection" |
| `gemini_last_generated` | ISO timestamp; `'0'` = never/force regen |
| `preferred_long_ride_days` | Comma-separated day names, e.g. `Saturday,Sunday` |
| `preferred_long_ride_day` | Legacy singular key (read as fallback) |
| `inactivity_pause_days` | Consecutive no-activity days before auto-pause (default 14) |
| `user_goals` | Free-text training goals, max 500 chars |
| `training_paused` | `'1'` while paused |
| `paused_since` / `pause_reason` | Set on pause, read on resume |
| `last_plan_activity_date` | Used by auto-pause inactivity detection |
| `setup_complete` | `'1'` when user confirmed HR profile |
| `instant_score_on_new_activity` | `'0'` disables instant regen-on-newly-completed-ride (default on, i.e. unset or `'1'`). Governs the **automatic** paths only — `/api/activities/refresh` and the auto-checks. Never gate explicit athlete input on it; see `triggerAdaptiveRegen()` |
| `free_training_mode` | `'1'` replaces the 14-day plan with a single dateless suggestion (see "Free training mode") |

---

## API endpoints

```
GET    /api/status                          ← Garmin session check → { loggedIn }
POST   /api/logout                          ← invalidate session
POST   /api/login                           ← { username, password } → { success } or { mfaRequired }
POST   /api/mfa                             ← { code } → { success }

GET    /api/dashboard                       ← { activities, analysis, profile } from DB (no Garmin call)
GET    /api/profile                         ← { maxHr, lthr, zones, ... } (opportunistically enriches maxHr from Garmin if not customized)
POST   /api/profile                         ← { maxHr, lthr, zones } → saves to DB and config.json (backward compat)

GET    /api/activities                      ← same as dashboard
POST   /api/activities/refresh              ← fetch from Garmin, upsert DB, re-run analysis → { …, newCount }
                                               → also classifies completed plan entries (non-blocking)
                                               → triggers instant AI regen on newly-completed rides
                                                 (non-blocking, gated by instant_score_on_new_activity)

GET    /api/checkin                         ← { today: DailyCheckin | null, history[] }
DELETE /api/checkin                         ← clears today's answer (back to never-answered) and
                                               re-plans without it; no-op when there was none
POST   /api/checkin                         ← { feeling: 1-5, note? } → upserts today, triggers
                                               an AI re-evaluation

POST   /api/activities/:activityId/feedback ← { rpe?: 1-10, feeling?: 1-5 } → writes to Garmin FIRST,
                                               then the local row; triggers an AI re-evaluation
                                               (gated by instant_score_on_new_activity)

POST   /api/sync-workouts                   ← { scheduleDate } → upload to Garmin + schedule Threshold

GET    /api/settings/gemini-key             ← { hasKey, maskedKey, setupComplete,
                                                preferredLongRideDays, geminiModel, inactivityPauseDays,
                                                instantScoreOnNewActivity, freeTrainingMode }
POST   /api/settings/gemini-key             ← { apiKey } → forces regen on next check
DELETE /api/settings/gemini-key             ← removes the API key
POST   /api/settings/gemini-model           ← { model } → normalized + format-validated, 400 on a bad ID
POST   /api/settings/preferred-long-ride-days  ← { days: string[] }
POST   /api/settings/inactivity-pause-days  ← { days: number } (1-365)
POST   /api/settings/instant-score-on-new-activity  ← { enabled: boolean }
POST   /api/settings/free-training-mode     ← { enabled: boolean } (also resets gemini_last_generated)
GET    /api/settings/training-goals         ← { goals }
POST   /api/settings/training-goals         ← { goals } (max 500 chars)
POST   /api/settings/setup-complete         ← marks setup as done

POST   /api/training/pause                  ← { reason } → pauses training
POST   /api/training/resume                 ← counts rides during pause, regenerates plan with pause context

GET    /api/recommendation                  ← stored plan, or { notConfigured } / { paused, ... } / { noData }
                                               → stale:true if generatedAt > 23h ago
                                               → regenerating:true while a generation is actually in flight
POST   /api/recommendation/refresh          ← syncs activities, then force-regenerates via Gemini
POST   /api/recommendation/skip-today       ← mark today 'skipped' → regenerate → return rec
POST   /api/recommendation/reschedule       ← { fromDate, toDate } → swap dates → regenerate

GET    /api/free-training                   ← free mode only (409 otherwise): stored suggestion + history
                                               → { notConfigured } / { paused, ... } / { noSuggestion }
                                               → else { suggestion, history[], stale, regenerating }
POST   /api/free-training/refresh           ← syncs activities, then generates the next suggestion
POST   /api/free-training/dismiss           ← mark current 'dismissed' → generate a replacement
POST   /api/free-training/sync              ← upload + schedule the suggestion on today's date

GET    /api/debug/raw-activity              ← debug-only: dumps raw Garmin activity/detail fields (RPE/feeling field discovery)
GET    /api/debug/garmin-hr-data            ← debug-only: dumps userData + an activity detail, scanned for zone/threshold/LTHR-related keys
                                               (discovering whether Garmin exposes a real LTHR/zone boundaries instead of Velomate's ×0.88 guess)

GET    *                                    ← SPA catch-all → serves Vue index.html (Vue Router history mode)
```

`GET/POST /api/devices*` and `GET /api/preview-workouts` from a previous version **no longer exist** — removed along with the dead `devices` table.

---

## Visual language (`frontend/src/assets/style.css`)

Dark, navy-based, one blue accent. The colours are unchanged from the original design; what was
tightened is the *execution*, because the combination of stock-Tailwind palette, glassmorphism panels
and ad-hoc radii is the visual signature of a generated dashboard.

- **Radius is a four-step scale** — `--radius-xs: 3px` (chips, badges, ticks), `--radius-sm: 5px`
  (buttons, inputs), `--radius-md: 8px` (cards, dialogs, editors), `--radius-pill: 999px` (only
  genuinely pill-shaped things). There were **fourteen** ad-hoc values before, up to 20px; oversized
  pill radii were most of what read as bubbly. Use a token, never a literal. `50%` (circles) and `2px`
  (caps on 4px-tall bars) stay literal on purpose: that is geometry, not style.
- **Depth comes from `--surface-0..3` plus a 1px `--hairline`**, not from blur or drop shadows. Current
  guidance is explicit that heavy shadows, glassmorphism panels and gradient KPI cards date within a
  year and cost legibility. `backdrop-filter` survives on exactly three rules, all **scrims behind a
  dialog** — a blurred backdrop is not glassmorphism. A panel that blurs what is under *itself* is, and
  none do any more. One shadow token remains, `--shadow-overlay`, for genuinely floating layers.
- **The accent is for things you can act on** — primary buttons, focus rings, active state. The settings
  dialog used to carry a brand-tinted border; spending the accent on decoration dilutes it everywhere
  it actually means something. Zone colours (`--z1..z5`) are exempt: those encode data.
- **`font-variant-numeric: tabular-nums` is set on `body`.** The app is mostly numbers, and with
  proportional digits a changing value visibly shifts its neighbours.
- **Positive letter-spacing belongs on small uppercase labels only.** On mixed-case headings it is the
  dated, webby look — `.card-header h2` is negative. Don't "fix" the uppercase labels to match.
- `.glass-panel` is a legacy class name: it is now just background + hairline + radius, and never had a
  `backdrop-filter` of its own.

## Frontend architecture (Vue 3 + Pinia + Vue Router)

The old vanilla-JS `setView()`/`currentView`/hidden-class toggling and `setRecState()` machinery is gone — replaced by Vue Router + a navigation guard, and by Pinia's reactive state.

### Routing (`frontend/src/router/index.ts`)
3 routes — `/setup` (SetupView), `/profile-setup` (ProfileSetupView), `/` (DashboardView) — plus a catch-all → `/`. A `router.beforeEach` guard (an explicit port of the old `maybeEnterDashboard()`) inits the `auth` + `settings` stores in parallel, then redirects: not logged in or AI not configured → `/setup`; HR setup incomplete → `/profile-setup`; otherwise away from setup screens → `/`.

### Pinia stores
- **`auth.store.ts`** — `isLoggedIn`, `loaded`, `showMfa`. `init()`, `refresh()` (polled every 30s), `login()`, `submitMfa()`, `logout()`
- **`settings.store.ts`** — `geminiConfigured`, `setupComplete`, `maskedKey`, `preferredLongRideDays[]`, `geminiModel`, `inactivityPauseDays`. `init()`/`reload()`, `saveAll()`, `saveInactivityPauseDays()`, `disconnectGemini()`, `savePreferredDays()`, `markSetupComplete()`
- **`recommendation.store.ts`** — `state: RecState` (`'not-configured' | 'no-plan' | 'loading' | 'loaded' | 'error' | 'paused'`), `recommendation`, `pausedSince`, `pauseReason`. `fetchCached()`, `refresh()`, `skipToday()`, `reschedule()`, `pollForUpdate()` (polls every 4s up to 10× for a changed `generatedAt` after a non-blocking backend regen), `pauseTraining()`, `resumeTraining()`, `syncWorkouts()`
- **`freeTraining.store.ts`** — free mode's counterpart to `recommendation.store`, same state-machine shape: `state: FreeState` (`'not-configured' | 'no-suggestion' | 'loading' | 'loaded' | 'error' | 'paused'`), `suggestion`, `history[]`. `fetchCached()`, `refresh()`, `dismiss()`, `syncWorkout()`, `pollForUpdate()`, `pauseTraining()`, `resumeTraining()`
- **`checkin.store.ts`** — `today`, `history[]`, computed `answeredToday`. `fetch()`, `save()`, `clear()`. Backs `DailyCheckinStrip.vue`, which is rendered by **both** `AiPlanCard.vue` and `FreeTrainingCard.vue` (loaded state only), above their scroll area.
- **`profile.store.ts`** — `profile`, computed `hrLabel`. `fetch()`, `save()`, `setFromDashboard()`
- **`activities.store.ts`** — `activities[]`, `analysis`, `loading`. `loadFromDb()` (DB-only, fast), `syncFromGarmin()` (full refresh, also updates profile store)

### Views
- **`SetupView.vue`** — checklist ("Connect Garmin", "Add AI API key") → opens `SettingsPanel` modal; no inline login form
- **`ProfileSetupView.vue`** — HR profile form (`HrZonesBar` preview), preferred long-ride days, free-text goals, auto-pause threshold. Also usable as a dashboard modal (`modalMode` prop, "edit profile"). Suggests maxHR/LTHR from `analysis.estimatedMaxHr/estimatedLthr` on mount
- **`DashboardView.vue`** — `MenuBar`, `ActivitiesCard`, `AiPlanCard` **or** `FreeTrainingCard` (by `settings.freeTrainingMode` — only the active mode's store is ever loaded or polled), `SettingsPanel`, teleported `ProfileSetupView` modal. Loads activities from DB, starts auth polling, fetches cached recommendation, silently polls for a fresher plan if one is regenerating in the background

### Key helpers
- `useTimeAgo()` composable (`composables/useTimeAgo.ts`) — same logic as the old vanilla `timeAgo()` helper, used in `ActivitiesCard.vue`/`LoadAssessment.vue`
- `isElectron()` / `electronAPI()` (`utils/electron.ts`) — feature-detect the Electron preload bridge
- `buildWeekWindow(plan, startOffset)` (`utils.ts`) — shared by `WeekGrid.vue` and `NextWeekSummary.vue`: slices a real 7-day window out of `weeklyPlan`, rolling from today (`This Week` = offset 0, `Next Week` = offset 7 — NOT a fixed Mon–Sun calendar week; that was tried and reverted because it shows fewer of the imminent days in full detail the later in the week "today" falls, worst case a Sunday start showing only today). Any date missing from `weeklyPlan` becomes a placeholder (`isPlaceholder: true`) — **never** a fabricated real rest day. A placeholder dated before today is additionally flagged `isPastPlaceholder: true` and rendered as quiet "No data" (`WeekDayCell.vue`/`WorkoutDetailPanel.vue`) rather than the actionable "Not planned yet" — dead code with the current rolling-only offsets (0 and 7 never produce a past date), kept as a harmless safety net in case a non-zero-or-positive offset is ever reintroduced. `describeCoverageGaps()` only counts non-past placeholders toward its "refresh to extend it" note for the same reason — but it's only wired up in `WeekGrid.vue` ("This Week"); `NextWeekSummary.vue` dropped it since a coverage gap 7-13 days out is expected/normal rather than something to flag.

---

## Profile setup flow

1. **`/setup`**: user connects Garmin + enters Gemini API key via the `SettingsPanel` modal
2. **`/profile-setup`**: auto-fetches Garmin rides to estimate maxHR/LTHR; user confirms or adjusts, sets training mode (free vs. planned), preferred long-ride days, goals, auto-pause threshold
   - On confirm: saves profile to DB (+ `config.json`), marks `setup_complete=1`, triggers first-plan generation
3. Router guard redirects to `/` (dashboard)

Also reachable as a **modal** from the dashboard (`modalMode=true`) without leaving the dashboard route.

---

## HR zones (backend calculation)

```typescript
// profile.service.ts — calculateDefaultZones(lthr, maxHr)
z1: 0          → round(lthr * 0.65)
z2: +1         → round(lthr * 0.80)
z3: +1         → round(lthr * 0.89)
z4: +1         → lthr
z5: lthr+1     → maxHr

// Thresholds used for zone classification elsewhere:
z4min = round(lthr * 0.89) + 1
z5min = lthr + 1
```

---

## Workout sync to Garmin

`POST /api/sync-workouts` → `syncAndScheduleWorkouts()` in `workout.service.ts`:
- Requires an active Garmin session; throws `'Not authenticated.'` otherwise
- Uses `getStoredProfile() ?? loadProfile()` (DB-first, `config.json` fallback) for HR-zone targets
- Only syncs types actually `'planned'` in the current plan (`SYNCABLE_TYPES = ['Sprint','VO2Max','Threshold','Tempo','LongRide']`); falls back to syncing all 5 if none are planned
- **LongRide's main block uses `LapPressDuration`** (open-ended, athlete presses Lap to finish); all other steps use a fixed `TimeDuration`
- Deletes existing Garmin workouts named `"Velomate - ..."` before re-uploading, to avoid duplicates
- Prefers the AI-generated `structure` per entry; falls back to hardcoded `FALLBACK_STRUCTURES` only if missing, and reports `usingFallback[]` so the frontend can prompt a regenerate
- Schedules the workout on `scheduleDate` (date of the first planned Threshold entry, computed frontend-side); if scheduling fails post-upload, still returns the workout with a `scheduleError` rather than failing the whole request
- `devDumpWorkouts()` writes built workout JSON to `./tmp/garmin-workouts/{timestamp}/` when `DEV_WORKOUT_DUMP=true`

---

## Daily check-in

The only signal that does not require riding. Everything else Velomate knows about an athlete's
state hangs off an activity, which left every rest day — and the bad night before one — silent, and
meant the single most important input in a "listen to your body" app could only be entered on the
watch, after a ride.

- **It is not RPE.** RPE lives per activity and syncs to Garmin; a check-in is per *day*, answers the
  days with no ride at all, and stays local — Garmin has no field for it. The two deliberately share
  the 1-5 feeling vocabulary (not the 1-10 RPE scale) so "3" means one thing everywhere.
- **Only ever today.** `upsertCheckin(localDate(), …)` is the single writer; nothing asks about or
  backfills an earlier day. History is read-only, for the prompt and the strip.
- **Picking a face is a selection, not a commitment.** Nothing is written until Save. An earlier version
  saved and re-planned on the tap itself, which made it impossible to add a note and spent an AI call on
  what the athlete thought was just selecting. Layout is fixed: faces row, note field, Save.
- **It sits at the top of the training card**, in both modes, above the card's scroll area — how the
  athlete feels today is the first input to everything shown underneath, so it must not scroll away. It
  lived above the rides list first, which put it nowhere near the thing it actually drives.
- **It stays ignorable.** A compact block, never a modal, no badge, no nagging. Skipping a day is a valid
  outcome, not a failure state — and absence is explicitly meaningless to the prompt.
- **Clear is not "rate yourself Normal".** `DELETE /api/checkin` removes the row, so the day reads as never
  answered and the prompt carries no line for it; a 3/Normal is still an answer the model weighs. Clearing
  re-plans too — the previous plan was built on a line that is now gone — but only when there was actually
  something to remove.
- **Re-planning requires new information.** `POST /api/checkin` compares against the stored answer for
  today and skips `triggerAdaptiveRegen()` when feeling *and* note are unchanged: the plan was already
  built on exactly that input, so regenerating would spend a call to arrive at the same place. Saving the
  same answer twice is therefore free, and `regenerating` in the response is the honest signal for whether
  the UI has anything to poll for.
- One row per local date (`date` is the PK); re-submitting corrects it, because a check-in is a
  present-tense statement and the athlete is allowed to change their mind during the day.
- `feeling` reuses the **same 1-5 scale and labels** as post-ride feeling (1 exhausted … 5 strong), so
  the vocabulary means one thing everywhere — in the badges, in the check-in block and in the prompt.
- The optional `note` is the only channel for anything outside cycling. Velomate deliberately does not
  import non-cycling activities: RPE, feeling and this note are where the athlete integrates them. The
  prompt says so explicitly, so the model takes "ran 10k yesterday" at face value.
- `CHECKIN_NOTES` (shared by both modes) states that a check-in **outranks** anything inferred from HR
  or volume, and that **a missing day carries no information** — absence must never be read as "fine".
  `buildCheckinBlock()` returns an empty string rather than an empty header for the same reason.
- `CHECKIN_HISTORY_DAYS` is a window in **days (14), not a row count**. Checking in is optional and many
  athletes do it sporadically, so "the last N rows" could reach back months and present a bad day from
  five weeks ago under a heading the model is told to weigh above everything else.

### `triggerAdaptiveRegen(context)`

Both a ride rating and a check-in call this: the athlete said something new about their own state, so
the plan re-evaluates. Non-blocking, and the response returns `regenerating` so the UI knows whether
to poll. It declines only when there is no API key or training is paused.

**Deliberately not gated by `instant_score_on_new_activity`.** Every caller is the athlete typing
something, and reacting to what they just told you is the product. That setting governs the *automatic*
paths only — a ride arriving on a background sync, where call volume is unbounded and the athlete asked
for nothing. It used to gate this function too, which meant unticking a box labelled "Score new rides
immediately" silently stopped check-ins from doing anything at all: the core loop switched off by a
control that said nothing about it. If you add a caller here, first ask whether a human pressed something.

It also returns **`replacedSyncedWorkout`**, and this is not optional polish. In free mode this call can
displace a suggestion the athlete already pushed to their watch — `runFreeAutoCheck()` refuses to do that
on staleness alone, but reacting to how someone actually feels outranks that rule. The Garmin workout
stays on their calendar either way and only they can delete it, so the response names what was displaced
and the UI warns about it. Dropping that field would silently orphan workouts in Garmin.

## Training pause / resume

New feature not present in earlier versions of the app:
- `POST /api/training/pause` — sets `training_paused='1'`, `paused_since`, `pause_reason`
- `POST /api/training/resume` — counts rides completed during the pause window, clears pause settings, regenerates the plan with pause context passed into the Gemini prompt
- Auto-pause also triggers from `runGeminiAutoCheck()` after `inactivityPauseDays` of no completed workouts
- `RecState = 'paused'` drives `PauseDialog.vue` / the paused UI state; `GET /api/recommendation` returns `{ paused: true, pausedSince, pauseReason }` while active

---

## Free training mode

An alternative to the 14-day plan, toggled by `free_training_mode` under **Training Mode** in the training
profile form (`ProfileSetupView.vue`, reachable as the dashboard's "edit profile" modal) — it sits with the
other training preferences, not with the AI connection settings. Instead of a
schedule, the AI returns **one dateless suggestion**: the single best next workout, ridden whenever the
athlete likes. Deliberately built as a parallel track, not a rewrite of plan mode.

**The plan is never destroyed.** Suggestions live in their own `free_suggestion` table; the
`recommendation` row is left untouched, so toggling back restores the plan (stale, then refreshed by the
normal 23h auto-check). Toggling either way resets `gemini_last_generated` to `'0'`.

**What is reused vs. what differs**

| Reused verbatim | Free-mode specific |
|---|---|
| `ACTIVITY_DATA_NOTES`, `WORKOUT_TYPE_GUIDELINES`, `CALIBRATION_GUIDELINES`, `SCORING_RUBRIC`, `buildRecentActivities()`, `buildZoneString()`, `buildPreferenceLines()`, `buildPauseBlock()`, `buildTrainingLoadBlock()`, `formatActivityLines()` — shared; the first four now live in each mode's system instruction rather than in the per-call text | `buildFreePrompt()` — one-workout framing, `coachNote` instead of a calendar slot, `PREVIOUS SUGGESTIONS` compliance block keyed by `[id N]` |
| `buildFromStructure()`, `zoneTarget()`, `workoutLabels()`, `FALLBACK_STRUCTURES` in `workout.service.ts` | `syncFreeWorkout()` — one workout, deletes only an **exact name clash** instead of every `"Velomate - "` workout, so previously synced suggestions survive as history |
| `WorkoutDetailPanel.vue` (new `dateless` prop hides the day label + Skip/Move), `LoadAssessment.vue`, `SyncResult.vue` (new `singleWorkout` prop), `usePauseDialog`, `useConfirm` | `FreeTrainingCard.vue`, `FreeHistoryList.vue`, `freeTraining.store.ts` |
| `buildPreferenceLines()` (goals block identical) | its `freeMode` argument swaps the "preferred Long Ride day" instruction for "the athlete chooses the day themselves" — there is no calendar to place a long ride on, and the UI says the same under those day chips |
| `/api/training/pause` + `/resume` (mode-agnostic; resume regenerates a suggestion instead of a plan) | `/api/free-training*` routes |

**Suggestion lifecycle** (`status` column):
`open` → `synced` (pushed to Garmin) → `completed` (a ride matched it) → scored by the AI on the next
generation. `dismissed` = athlete rejected it, or had it synced and never rode it; `superseded` = **the
athlete** asked for a different one before syncing it; `expired` = an automatic regeneration replaced it.
`insertFreeSuggestion()` retires the current row inside one transaction, so there is always at most one
`open`/`synced` row.

**`superseded` vs `expired` is not bookkeeping.** The prompt reads repeated rejection of a workout type as
a reason to stop offering it, so recording an automatic refresh as a rejection teaches the AI something
that never happened — and regeneration fires automatically on staleness, on a new ride, and on every
check-in. Only an explicit refresh passes `athleteRequested: true` to `generateFreeSuggestion()`; the
`expired` line in the prompt says outright that no compliance conclusion may be drawn from it.

**Rest is not a valid free-mode suggestion.** It is in `WORKOUT_TYPE_GUIDELINES` (shared) but the free
schema omits it, the STRICT RULES forbid it, and `_attemptFreeGeneration()` rejects it. A dateless rest
suggestion is something the athlete cannot ride, cannot sync and can never complete, so it would occupy
the mode's single slot until it expired. Recovery advice goes in `coachNote` + a `low` priority instead:
name the session they should come back to and say plainly that they should not ride it yet. `buildCheckinNotes(freeMode)`
is mode-aware for exactly this reason — telling free mode to "make it Rest" would be an instruction it is
forbidden to follow. Frontend guards (`isSyncable`, the `isRest` card header) stay as safety nets, because
suggestions stored before this change still render.

**Ride matching** — `findRideForFreeSuggestion(syncedForDate)` takes the **first activity on or after**
that date (Velomate-named wins, else longest of that day). Deliberately forward-looking, unlike the plan's
strict same-date `classifyCompletedEntries()`: syncing Monday and riding Wednesday is still that session.

**Sync = the only date it ever gets.** `POST /api/free-training/sync` stamps `localDate()` (the day the
button was pressed) into `syncedForDate`, the workout name (`Velomate - Wed 27 Aug: Tempo`) and the Garmin
calendar slot — that press date is what makes a synced suggestion traceable afterwards, and the UI shows it
back as "Synced to Garmin on Wednesday 27 August".

**Auto-check** — `runGeminiAutoCheck()` delegates to `runFreeAutoCheck()` in free mode. Same shape minus
everything date-bound (no auto-skips): sync → settle a synced suggestion against new rides → regen if one
just completed (gated by `instant_score_on_new_activity`) → shared `maybeAutoPause()` → regen if >23h stale.
Two invariants:
- **The first suggestion is never auto-generated** — same rule as the first plan.
- **A `synced` suggestion is never replaced on staleness alone.** It is sitting on the athlete's watch and
  free mode has no deadline, so replacing it would mark it not-ridden and orphan the Garmin workout. Only a
  matched ride, an explicit refresh/dismiss, or the inactivity auto-pause moves it on.

**Inactivity clock** — free mode has no completed plan entries to stamp `last_plan_activity_date` from, so
`syncActivitiesFromGarmin()` stamps it from the most recent ride instead. Without this, auto-pause would
fire on an athlete who is training perfectly well.

**Switching mid-session** — `DashboardView.vue` watches `settings.freeTrainingMode` and calls `loadActiveMode()`.
Without it, toggling in the profile modal swaps the card while the store behind the newly shown one has never
been fetched, leaving it stuck on its initial `loading` state until a reload.

**Mode guards** — `requireMode(res, wantFree)` returns 409 when a request targets the inactive mode. Applied
to `/api/recommendation/refresh|skip-today|reschedule` and `/api/sync-workouts` (plan-only), and to every
`/api/free-training*` route (free-only).

---

## Electron desktop shell

`electron-main.js` (repo root, CommonJS, guarded by `if (process.type !== 'browser') return` since Windows launches it twice):
- Single-instance lock (`requestSingleInstanceLock`) — second launch just focuses the existing window
- Default window 1400x1040, clamped to screen.getPrimaryDisplay().workAreaSize so it never opens taller than the display. Height was raised from 900 when the daily check-in moved into the training card — at 900 the plan card opened already scrolled.
- Frameless window on Windows (custom `TitleBar.vue` + IPC `window:minimize/toggle-maximize/close`), native title bar (`hiddenInset`) on macOS
- Runs the Express backend **in-process**: `require('./backend/dist/server.js')`. Packaged builds pick a free port dynamically (`findFreePort()`) and set `LOG_DIR` to `app.getPath('userData')/logs`; dev mode uses the fixed port 2012
- Waits for `GET /api/status` to respond (`waitForHttp()`) before loading the window
- `dialog.showErrorBox()` on startup failure — a packaged app has no console, so a silent failure would otherwise just vanish

### Auto-update (electron-updater, GitHub Releases)
Only active when `app.isPackaged` (never in dev):
- `autoDownload = true`, `autoInstallOnAppQuit = true`
- Checks on startup, then every `UPDATE_CHECK_INTERVAL_MS` (4h)
- `update-available` → IPC `update:status {state:'downloading', version}`; `update-downloaded` → `{state:'ready', version}`
- Frontend: `useUpdater()` composable holds the shared status; `UpdateBanner.vue` renders it and calls `restartAndInstallUpdate()` → IPC `update:restart-and-install` → `autoUpdater.quitAndInstall()`
- Update feed = GitHub Releases of `t0r3x/Velomate` (`electron-builder.yml`'s `publish` block) — same place `npm run electron:publish` uploads installers to

### Build/publish
```bash
npm run electron:build     # electron-builder --publish never  → dist-electron/, local testing only
npm run electron:publish   # electron-builder --publish always → uploads a GitHub Release (needs GH_TOKEN, repo scope)
```
Bump `version` in root `package.json` before every publish — it's both the release tag and what electron-updater compares against installed versions. `sign: false` on Windows — installer is unsigned, users will see a SmartScreen warning.

---

## Important gotchas

1. **DB location moved out of `backend/data/`** for packaged Electron builds — it now lives in the OS user-data dir (`%APPDATA%\velomate\velomate.db` / `~/.velomate/velomate.db`), overridable via `VELOMATE_DB_PATH`. Docker/dev still default to `backend/data/velomate.db`.
2. **No first-plan auto-generation** — `runGeminiAutoCheck()` never creates the first plan; only user action (or `/api/training/resume`) does.
3. **Gemini response truncation** — always join all parts: `parts.map(p => p.text ?? '').join('')`; also handled via the shrinking `ACTIVITY_WINDOWS` retry.
4. **`classifyExecution()` no longer exists** — completion matching is now binary/date-based; all quality scoring (0-100 + note) comes from the AI in the same call that regenerates the plan. Don't look for rule-based Sprint/Threshold/LongRide thresholds in `gemini.service.ts`.
5. **`perceivedExertion`/`feelingAfterExercise`** are excluded from the bulk-upsert `ON CONFLICT` update in `database.service.ts` — never overwritten by a routine activity sync. They have exactly two writers: `fetchAndStoreRecentFeedback()` (pulling what the athlete entered on the watch) and `POST /api/activities/:id/feedback` (what they entered in Velomate).
6. **Ride feedback is written to Garmin before it is written locally.** RPE and feeling normally originate on the watch and are read back from Garmin, so a value stored only in Velomate would diverge the moment the athlete opens Garmin Connect. `pushActivityFeedback()` PUTs `{ activityId, summaryDTO: { directWorkoutRpe, directWorkoutFeel } }` to `/activity-service/activity/{id}` — a partial body, the same mechanism the client library uses for `renameActivity` — and `updateActivityFeedback()` only runs once that succeeded. A failed write leaves both sides untouched and the UI keeps its editor open. Do not reorder these: a local-first write would silently create two different answers to "how did that ride feel", and the AI reads the local one.
7. **Entering a rating is a planning signal, not metadata.** It triggers the same non-blocking regeneration a newly completed ride does — reacting to how the athlete actually feels is the product, so a rating that changed nothing would be the bug. Honours `instant_score_on_new_activity` for athletes who would rather save the API call.
8. **`getStoredRecommendation()` can return null** even right after a write (JSON parse failure or race). Always use optional chaining: `updated?.weeklyPlan`.
9. **Preferred days plural key** — `preferred_long_ride_days` (comma-separated). Legacy `preferred_long_ride_day` is read as fallback but never written.
10. **UI language** — always English only. Variable names, DB keys, logs can be Dutch/English but all user-visible text must be English.
11. **AI branding is mostly, not entirely, "AI"-only** — component names, most copy, and toasts say "AI" (`AiPlanCard.vue`, "Add AI API key"). But `SettingsPanel.vue` still names "Google Gemini" explicitly in a couple of spots (header, key-help text, disconnect toast) since that's the actual product the user needs an API key from. Internal names (`gemini_api_key`, `getGeminiKeyStatus`, etc.) keep "gemini" throughout — this is intentional, not a bug to "fix" by blanket-replacing "Gemini" with "AI".
12. **`config.json` is still alive** — `profile.service.ts` reads/writes it as a legacy fallback; `POST /api/profile` keeps it in sync "for backward compat". Don't remove it without checking `getActiveProfile()`'s DB → config.json → defaults fallback chain in `server.ts`.
13. **`setupComplete` comes from DB**, loaded via the settings store (`GET /api/settings/gemini-key` → `data.setupComplete`). Do not use localStorage.
14. **WAL mode** — SQLite is opened with `db.pragma('journal_mode = WAL')` for better concurrent reads.
15. **`GET /api/debug/raw-activity`** and **`GET /api/debug/garmin-hr-data`** are diagnostic-only endpoints (discovering Garmin's RPE/feeling field names, and real LTHR/zone-boundary field names, respectively) — don't treat them as public API surface.
16. **Backend port is 2012**, not 3001 — legacy docs/scripts referencing 3001 are stale. It binds **127.0.0.1 by default**: no API route is authenticated, so an all-interfaces bind would expose ride history, the debug endpoints, the AI key and Garmin workout upload to anyone on the same network. Electron and the Vite dev proxy both target 127.0.0.1 explicitly. Set `BIND_HOST=0.0.0.0` to opt in to remote access — `docker-compose.yml` does, since a container that binds loopback is unreachable through a published port.
17. **Free training mode swaps the card, it does not migrate the data** — `recommendation` and `free_suggestion` coexist. Never "clean up" one while the other is active; that is what makes toggling back lossless.
18. **`gemini_model` is user-controlled free text that lands in a URL** — always go through `getGeminiModel()` to read it and `normalizeModelId()`/`isValidModelId()` to write it. See "AI model selection".
19. **The shared prompt blocks are literally shared** — editing `WORKOUT_TYPE_GUIDELINES`, `CALIBRATION_GUIDELINES`, `SCORING_RUBRIC` or `ACTIVITY_DATA_NOTES` changes coaching behaviour in **both** modes. That is intentional; if a change should only apply to one mode, put it in that mode's own template. They are interpolated into both system instructions, so a change also invalidates the cached prefix for every user — correctness-neutral, but not free.
20. **Prompt rules must be evaluable from the prompt itself.** Two rules were asking the model to judge things it had never been given: stability condition (d) compared against an unseen previous assessment, and a progression rule keyed on `'easy'`/`'moderate'` rides — words quoted as if they were data fields, which no activity line carries. Both are now either supplied (`buildPreviousAssessmentBlock()`) or defined numerically ("no ride shows more than roughly 5 minutes of combined Z4+Z5 time"). When adding a rule, check that every term in it appears in the data the model actually receives.
