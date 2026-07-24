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

recommendation -- id=1 singleton: current AI training plan
  id=1, workoutType, reason, priority TEXT,
  weeklyPlan TEXT (JSON PlanEntry[7], entries carry executionScore/executionNote),
  nextWeekOverview TEXT (JSON), loadAssessment TEXT (JSON), generatedAt TEXT
```

**The `devices` table is gone** — it was dead code (no reads/writes, no route) and was dropped along with `GET/POST /api/devices*`.

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

1. **Binary match** (`classifyCompletedEntries()` in `gemini.service.ts`): any planned entry with a Garmin activity on that date → `'completed'`. Tie-break: an activity named "Velomate" wins, else the longest ride of the day.
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
2. Sync activities, detect auto-skips (`detectAutoSkippedEntries()`, excludes dates inside a completed pause window) → regenerate if any found
3. Auto-pause training after `inactivityPauseDays` (default 14, user-configurable) consecutive days with no completed workout
4. Otherwise regenerate only if plan is >23h stale
5. On Gemini 429 → stamp `gemini_last_generated` to back off for 23h

The first plan is never created here — only steps 2-4 ever fire, and they all require an existing plan.

### `generateRecommendation(previousPlan?, pauseContext?, pinnedTodayType?)`
- Retries with a shrinking activity window (`ACTIVITY_WINDOWS = [21, 14, 10]` days) if Gemini's response is truncated (`finishReason === 'MAX_TOKENS'`)
- POSTs to `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`, retries up to 3× on HTTP 429 with backoff
- `responseMimeType: "application/json"`, joins all parts: `parts.map(p => p.text ?? '').join('')` — avoids truncation
- Validates: `today.type` in the valid set, `weeklyPlan` is exactly 7 entries
- Merges statuses/scores with the previous plan — never re-scores an already-scored entry; keeps a rolling 14-day scored history prepended to the new 7-day window
- Recomputes `structure.totalMinutes` from steps (corrects AI rounding)
- Always returns `getStoredRecommendation()` (i.e., what was just saved to DB)

### `buildPrompt()` assembles
today's date/day-of-week, athlete preferences (preferred long-ride days, free-text goals), pause context, previous-plan compliance (completed/skipped/auto-skipped with RPE/feeling), pinned-today block, existing scheduled workouts, last-21-day (or reduced) activity JSON, HR profile/zones, 90-day analysis, workout-type guidelines (Sprint/VO2Max/Threshold/Tempo/LongRide/Rest), progression goals, the execution-scoring rubric, the JSON output schema, and plan-stability rules.

### Settings stored in DB
| Key | Description |
|-----|-------------|
| `gemini_api_key` | Raw API key |
| `gemini_model` | e.g. `gemini-3.5-flash` |
| `gemini_last_generated` | ISO timestamp; `'0'` = never/force regen |
| `preferred_long_ride_days` | Comma-separated day names, e.g. `Saturday,Sunday` |
| `preferred_long_ride_day` | Legacy singular key (read as fallback) |
| `inactivity_pause_days` | Consecutive no-activity days before auto-pause (default 14) |
| `user_goals` | Free-text training goals, max 500 chars |
| `training_paused` | `'1'` while paused |
| `paused_since` / `pause_reason` | Set on pause, read on resume |
| `last_plan_activity_date` | Used by auto-pause inactivity detection |
| `setup_complete` | `'1'` when user confirmed HR profile |

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
POST   /api/activities/refresh              ← fetch from Garmin, upsert DB, re-run analysis
                                               → also classifies completed plan entries (non-blocking)

POST   /api/sync-workouts                   ← { scheduleDate } → upload to Garmin + schedule Threshold

GET    /api/settings/gemini-key             ← { hasKey, maskedKey, setupComplete,
                                                preferredLongRideDays, geminiModel, inactivityPauseDays }
POST   /api/settings/gemini-key             ← { apiKey } → forces regen on next check
DELETE /api/settings/gemini-key             ← removes the API key
POST   /api/settings/gemini-model           ← { model }
POST   /api/settings/preferred-long-ride-days  ← { days: string[] }
POST   /api/settings/inactivity-pause-days  ← { days: number } (1-365)
GET    /api/settings/training-goals         ← { goals }
POST   /api/settings/training-goals         ← { goals } (max 500 chars)
POST   /api/settings/setup-complete         ← marks setup as done

POST   /api/training/pause                  ← { reason } → pauses training
POST   /api/training/resume                 ← counts rides during pause, regenerates plan with pause context

GET    /api/recommendation                  ← stored plan, or { notConfigured } / { paused, ... } / { noData }
                                               → stale:true if generatedAt > 23h ago
POST   /api/recommendation/refresh          ← syncs activities, then force-regenerates via Gemini
POST   /api/recommendation/skip-today       ← mark today 'skipped' → regenerate → return rec
POST   /api/recommendation/reschedule       ← { fromDate, toDate } → swap dates → regenerate

GET    /api/debug/raw-activity              ← debug-only: dumps raw Garmin activity/detail fields (RPE/feeling field discovery)

GET    *                                    ← SPA catch-all → serves Vue index.html (Vue Router history mode)
```

`GET/POST /api/devices*` and `GET /api/preview-workouts` from a previous version **no longer exist** — removed along with the dead `devices` table.

---

## Frontend architecture (Vue 3 + Pinia + Vue Router)

The old vanilla-JS `setView()`/`currentView`/hidden-class toggling and `setRecState()` machinery is gone — replaced by Vue Router + a navigation guard, and by Pinia's reactive state.

### Routing (`frontend/src/router/index.ts`)
3 routes — `/setup` (SetupView), `/profile-setup` (ProfileSetupView), `/` (DashboardView) — plus a catch-all → `/`. A `router.beforeEach` guard (an explicit port of the old `maybeEnterDashboard()`) inits the `auth` + `settings` stores in parallel, then redirects: not logged in or AI not configured → `/setup`; HR setup incomplete → `/profile-setup`; otherwise away from setup screens → `/`.

### Pinia stores
- **`auth.store.ts`** — `isLoggedIn`, `loaded`, `showMfa`. `init()`, `refresh()` (polled every 30s), `login()`, `submitMfa()`, `logout()`
- **`settings.store.ts`** — `geminiConfigured`, `setupComplete`, `maskedKey`, `preferredLongRideDays[]`, `geminiModel`, `inactivityPauseDays`. `init()`/`reload()`, `saveAll()`, `saveInactivityPauseDays()`, `disconnectGemini()`, `savePreferredDays()`, `markSetupComplete()`
- **`recommendation.store.ts`** — `state: RecState` (`'not-configured' | 'no-plan' | 'loading' | 'loaded' | 'error' | 'paused'`), `recommendation`, `pausedSince`, `pauseReason`. `fetchCached()`, `refresh()`, `skipToday()`, `reschedule()`, `pollForUpdate()` (polls every 4s up to 10× for a changed `generatedAt` after a non-blocking backend regen), `pauseTraining()`, `resumeTraining()`, `syncWorkouts()`
- **`profile.store.ts`** — `profile`, computed `hrLabel`. `fetch()`, `save()`, `setFromDashboard()`
- **`activities.store.ts`** — `activities[]`, `analysis`, `loading`. `loadFromDb()` (DB-only, fast), `syncFromGarmin()` (full refresh, also updates profile store)

### Views
- **`SetupView.vue`** — checklist ("Connect Garmin", "Add AI API key") → opens `SettingsPanel` modal; no inline login form
- **`ProfileSetupView.vue`** — HR profile form (`HrZonesBar` preview), preferred long-ride days, free-text goals, auto-pause threshold. Also usable as a dashboard modal (`modalMode` prop, "edit profile"). Suggests maxHR/LTHR from `analysis.estimatedMaxHr/estimatedLthr` on mount
- **`DashboardView.vue`** — `MenuBar`, `ActivitiesCard`, `AiPlanCard`, `SettingsPanel`, teleported `ProfileSetupView` modal. Loads activities from DB, starts auth polling, fetches cached recommendation, silently polls for a fresher plan if one is regenerating in the background

### Key helpers
- `useTimeAgo()` composable (`composables/useTimeAgo.ts`) — same logic as the old vanilla `timeAgo()` helper, used in `ActivitiesCard.vue`/`LoadAssessment.vue`
- `isElectron()` / `electronAPI()` (`utils/electron.ts`) — feature-detect the Electron preload bridge

---

## Profile setup flow

1. **`/setup`**: user connects Garmin + enters Gemini API key via the `SettingsPanel` modal
2. **`/profile-setup`**: auto-fetches Garmin rides to estimate maxHR/LTHR; user confirms or adjusts, sets preferred long-ride days, goals, auto-pause threshold
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

## Training pause / resume

New feature not present in earlier versions of the app:
- `POST /api/training/pause` — sets `training_paused='1'`, `paused_since`, `pause_reason`
- `POST /api/training/resume` — counts rides completed during the pause window, clears pause settings, regenerates the plan with pause context passed into the Gemini prompt
- Auto-pause also triggers from `runGeminiAutoCheck()` after `inactivityPauseDays` of no completed workouts
- `RecState = 'paused'` drives `PauseDialog.vue` / the paused UI state; `GET /api/recommendation` returns `{ paused: true, pausedSince, pauseReason }` while active

---

## Electron desktop shell

`electron-main.js` (repo root, CommonJS, guarded by `if (process.type !== 'browser') return` since Windows launches it twice):
- Single-instance lock (`requestSingleInstanceLock`) — second launch just focuses the existing window
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
5. **`perceivedExertion`/`feelingAfterExercise`** are excluded from the bulk-upsert `ON CONFLICT` update in `database.service.ts` — never overwritten by a routine activity sync, only by the dedicated feedback fetch.
6. **`getStoredRecommendation()` can return null** even right after a write (JSON parse failure or race). Always use optional chaining: `updated?.weeklyPlan`.
7. **Preferred days plural key** — `preferred_long_ride_days` (comma-separated). Legacy `preferred_long_ride_day` is read as fallback but never written.
8. **UI language** — always English only. Variable names, DB keys, logs can be Dutch/English but all user-visible text must be English.
9. **AI branding is mostly, not entirely, "AI"-only** — component names, most copy, and toasts say "AI" (`AiPlanCard.vue`, "Add AI API key"). But `SettingsPanel.vue` still names "Google Gemini" explicitly in a couple of spots (header, key-help text, disconnect toast) since that's the actual product the user needs an API key from. Internal names (`gemini_api_key`, `getGeminiKeyStatus`, etc.) keep "gemini" throughout — this is intentional, not a bug to "fix" by blanket-replacing "Gemini" with "AI".
10. **`config.json` is still alive** — `profile.service.ts` reads/writes it as a legacy fallback; `POST /api/profile` keeps it in sync "for backward compat". Don't remove it without checking `getActiveProfile()`'s DB → config.json → defaults fallback chain in `server.ts`.
11. **`setupComplete` comes from DB**, loaded via the settings store (`GET /api/settings/gemini-key` → `data.setupComplete`). Do not use localStorage.
12. **WAL mode** — SQLite is opened with `db.pragma('journal_mode = WAL')` for better concurrent reads.
13. **`GET /api/debug/raw-activity`** is a diagnostic-only endpoint (discovering Garmin's RPE/feeling field names) — don't treat it as public API surface.
14. **Backend port is 2012**, not 3001 — legacy docs/scripts referencing 3001 are stale.
