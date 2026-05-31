# Velomate — Project Reference

> Cycling dashboard with Garmin Connect integration and AI-driven adaptive training plans.  
> Backend: Express/TypeScript + better-sqlite3 · Frontend: Vanilla JS + Font Awesome · DB: SQLite

---

## Running the project

```bash
# From /backend
npm run dev       # ts-node + nodemon, port 3001
npm run build     # tsc → dist/
npx tsc --noEmit  # type-check only (no output)
```

Frontend is served as static files from `backend/src/server.ts`:
```typescript
app.use(express.static(path.join(__dirname, '../../frontend')));
```
Open http://localhost:3001 — no separate frontend server needed.

---

## Directory layout

```
velomate/
├── backend/
│   ├── src/
│   │   ├── server.ts                  ← Express app + all API routes
│   │   ├── types.ts                   ← Shared TypeScript types (UserHRProfile)
│   │   └── services/
│   │       ├── database.service.ts    ← SQLite CRUD (better-sqlite3, sync)
│   │       ├── gemini.service.ts      ← Gemini API + plan classification
│   │       ├── activity.service.ts    ← Garmin activity fetch + Garmin data mapping
│   │       ├── garmin.service.ts      ← OAuth2/session management
│   │       ├── sso.service.ts         ← Garmin SSO login flow + MFA
│   │       ├── profile.service.ts     ← HR profile calc + config.json fallback
│   │       └── workout.service.ts     ← Garmin workout upload + schedule
│   ├── data/
│   │   └── velomate.db                ← SQLite DB (git-ignored)
│   └── config.json                    ← HR profile fallback (legacy, migrated to DB)
└── frontend/
    ├── index.html
    ├── app.js
    └── style.css
```

---

## Database schema (better-sqlite3, synchronous)

```sql
activities    -- Garmin cycling activities (upsert by activityId)
  activityId TEXT PK, name, type, startTime, distanceKm, durationMinutes,
  averageHr, maxHr, averagePower, maxPower, timeInZones TEXT (JSON [s,s,s,s,s]), fetchedAt

analysis      -- id=1 singleton: computed stats over last 90 days
  id=1, totalCyclingRides, maxRecordedHr, estimatedMaxHr, estimatedLthr,
  averageRideDurationMinutes, suggestedZones TEXT (JSON), updatedAt

profile       -- id=1 singleton: user HR profile (maxHr, lthr, zones)
  id=1, maxHr, lthr, zones TEXT (JSON), hasCustomOverrides INTEGER, lastUpdated

devices       -- Garmin device registry cache
  deviceId TEXT PK, displayName, activityTypes TEXT (JSON), rawData TEXT (JSON), fetchedAt

settings      -- key/value store
  key TEXT PK, value TEXT
  Keys used: gemini_api_key, gemini_model, gemini_last_generated,
             setup_complete, preferred_long_ride_days, preferred_long_ride_day (legacy)

recommendation -- id=1 singleton: current AI training plan
  id=1, workoutType TEXT, reason TEXT, priority TEXT,
  weeklyPlan TEXT (JSON PlanEntry[7]), nextWeekOverview TEXT (JSON), loadAssessment TEXT (JSON),
  generatedAt TEXT
```

---

## Key types

```typescript
// PlanEntry.status — the full set (all used in UI + prompts)
type PlanEntryStatus =
  | 'planned'
  | 'completed'           // activity matched planned type (correct zone profile)
  | 'completed-partial'   // done but execution quality below target
  | 'completed-mismatch'  // activity recorded but wrong intensity type
  | 'skipped'             // user clicked Skip
  | 'auto-skipped';       // day passed with no activity recorded

interface PlanEntry {
  date: string;           // YYYY-MM-DD
  type: string;           // Sprint | Threshold | LongRide | Rest
  reason: string;
  status: PlanEntryStatus;
  structure?: WorkoutStructure | null;
}

interface WorkoutStep {
  stepType: 'WarmUp' | 'Run' | 'Recovery' | 'Cooldown';
  durationSec: number;    // positive integer
  zone: 'z1' | 'z2' | 'z3' | 'z4' | 'z5';
  label: string;
}
```

---

## Garmin zone data

Activities store `timeInZones: number[]` — 5 elements, seconds per zone (index 0=Z1…4=Z5).  
Source fields tried in order: `act.hrTimeInHrZone || act.timeInHrZone`.  
These are Garmin's built-in 5 zones based on % max HR — boundaries differ slightly from the user's custom LTHR zones. Classification logic accounts for this with generous thresholds.

**`classifyExecution(act, planType, lthr, z4min, z5min)`** in `gemini.service.ts`:
- Sprint: z5Sec ≥ 60s → completed; z5Sec > 0 → partial; else → mismatch
- Threshold: z4Sec ≥ 720s → completed; z4Sec ≥ 240s → partial; else → mismatch
- LongRide: durationMin ≥ 75 and avgHr < z4min → completed; durationMin ≥ 45 → partial
- Falls back to avgHr-based logic when zone data is unavailable

---

## AI / Gemini integration

### Key invariant
The **first plan** is ONLY generated when the user explicitly clicks **"Generate my first plan"** on the `rec-state-no-plan` screen.

- Confirming HR profile in Step 2 calls `fetchRecommendation(false)` (read-only) → shows `rec-state-no-plan` with the button
- The hourly auto-check (`runGeminiAutoCheck`) **never creates the first plan** — it early-returns if `getStoredRecommendation()` is null

### Auto-check logic (runs on startup + every hour)
1. No API key → skip
2. Detect auto-skips (planned days in past with no Garmin activity) → mark + regenerate
3. No plan in DB → log + return (first plan is user-initiated)
4. Plan age > 23h → regenerate

### generateRecommendation(previousPlan?)
- Builds prompt via `buildPrompt()` with recent 21-day activities (including `zonesMin`), profile, analysis, compliance block
- Previous plan compliance shows COMPLETED/COMPLETED-PARTIAL/COMPLETED-MISMATCH with zone breakdown per entry
- Gemini REST API: `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
- `responseMimeType: "application/json"`, `temperature: 0.4`, `maxOutputTokens: 4096`
- Joins all parts: `parts.map(p => p.text ?? '').join('')` — avoids truncation
- Validates: `today.type` in valid set, `weeklyPlan` is array of exactly 7
- Preserves existing non-'planned' statuses from previousPlan
- Recomputes `structure.totalMinutes` from steps (corrects AI rounding)
- Always returns `getStoredRecommendation()` (i.e., what was just saved to DB)

### Settings stored in DB
| Key | Description |
|-----|-------------|
| `gemini_api_key` | Raw API key |
| `gemini_model` | e.g. `gemini-3.5-flash` |
| `gemini_last_generated` | ISO timestamp; `'0'` = never/force regen |
| `preferred_long_ride_days` | Comma-separated day names, e.g. `Saturday,Sunday` |
| `preferred_long_ride_day` | Legacy singular key (read as fallback) |
| `setup_complete` | `'1'` when user confirmed HR profile |

---

## API endpoints

```
GET  /api/status                          ← Garmin session check → { loggedIn }
POST /api/login                           ← { username, password } → { success } or { mfaRequired }
POST /api/mfa                             ← { code } → { success }
POST /api/logout                          ← invalidate session

GET  /api/dashboard                       ← { activities, analysis, profile } from DB (no Garmin call)
GET  /api/activities                      ← same as dashboard
POST /api/activities/refresh              ← fetch from Garmin, upsert DB, re-run analysis
                                            → also classifies completed plan entries (non-blocking)

GET  /api/profile                         ← { maxHr, lthr, zones, ... }
POST /api/profile                         ← { maxHr, lthr, zones }

GET  /api/devices                         ← from DB cache; fetches Garmin on first use
POST /api/devices/refresh                 ← force re-fetch from Garmin

GET  /api/settings/gemini-key             ← { hasKey, maskedKey, setupComplete,
                                              preferredLongRideDays, geminiModel }
POST /api/settings/gemini-key             ← { apiKey }
POST /api/settings/gemini-model           ← { model }
POST /api/settings/preferred-long-ride-days  ← { days: string[] }
POST /api/settings/setup-complete         ← marks setup as done

GET  /api/recommendation                  ← stored plan or { notConfigured } or { noData }
                                            → stale:true if generatedAt > 23h ago
POST /api/recommendation/refresh          ← generateRecommendation(currentPlan) → full rec
POST /api/recommendation/skip-today       ← mark today 'skipped' → regenerate → return rec
POST /api/recommendation/reschedule       ← { fromDate, toDate } → swap dates → regenerate

GET  /api/preview-workouts                ← upcoming planned workouts with step details
POST /api/sync-workouts                   ← { scheduleDate } → upload to Garmin + schedule Threshold
```

---

## Frontend architecture

### Views (multi-view SPA)
```
view-setup          ← Step 1: connect Garmin + enter AI API key
view-profile-setup  ← Step 2: confirm HR profile (also opens as modal overlay from dashboard)
view-dashboard      ← Main app
```

`setView(name)` toggles `hidden` class on the three view divs.  
`currentView` is `null` until the first routing decision is made.

### Init routing gate (`maybeEnterDashboard`)
Both async init calls must complete before any view routing:
```javascript
let statusLoaded       = false;   // set by checkStatus()
let geminiStatusLoaded = false;   // set by fetchGeminiKeyStatus()

const maybeEnterDashboard = () => {
  if (!statusLoaded || !geminiStatusLoaded) return;
  // ... route based on isLoggedIn + geminiConfigured + setupComplete
};
```
This prevents flashing the wrong view when one resolves before the other.

### AI card state machine
`setRecState(state)` toggles visibility of:
- `rec-state-not-configured` — no API key
- `rec-state-no-plan` — key set but no plan generated yet (first use)
- `rec-state-loading` — Gemini API call in flight
- `rec-state-loaded` — plan rendered
- `rec-state-error` — API error with retry button

### Key helpers
```javascript
cloneTemplate(id)         // clones <template> by id, returns root element
setBtn(btn, state)        // reads data-{state}-label / data-{state}-icon attrs
timeAgo(isoStr)           // "3h ago", "just now", etc.
```

### Init sequence
```javascript
loadDashboard();              // immediate DB render, no Garmin call
checkStatus();                // Garmin session check → sets statusLoaded
fetchGeminiKeyStatus();       // AI key + setupComplete → sets geminiStatusLoaded
fetchRecommendation();        // load cached plan from DB
setInterval(checkStatus, 30000);
```

---

## Profile setup flow

1. **Step 1 (setup view)**: User connects Garmin (login/MFA) + enters Gemini API key
2. **Step 2 (profile-setup view)**: Auto-fetches Garmin rides to estimate maxHR/LTHR; user confirms or adjusts
   - On confirm: saves profile to DB, marks `setup_complete=1`, calls `fetchRecommendation(true)` (first plan generation)
3. Dashboard is shown

The profile setup can also be opened as a **modal overlay** from the dashboard (`btn-edit-hr-profile`). In this case `psModalMode=true` and the main view is not changed.

---

## HR zones (backend calculation)

```typescript
// profile.service.ts — calculateDefaultZones(lthr, maxHr)
z1: 0          → round(lthr * 0.65)
z2: +1         → round(lthr * 0.80)
z3: +1         → round(lthr * 0.89)
z4: +1         → lthr
z5: lthr+1     → maxHr

// Thresholds used in classifyExecution:
z4min = round(lthr * 0.89) + 1
z5min = lthr + 1
```

---

## Workout sync to Garmin

`POST /api/sync-workouts` calls `syncAndScheduleWorkouts(weeklyPlan, scheduleDate)` in `workout.service.ts`.  
- Uploads Sprint, Threshold, LongRide as structured workouts to Garmin
- Schedules the **Threshold** workout on `scheduleDate` (date of first planned Threshold in weekly plan)
- The `scheduleDate` is derived from `currentRecommendation.weeklyPlan` in the frontend — first planned Threshold entry's date

---

## Important gotchas

1. **No first-plan auto-generation** — `runGeminiAutoCheck` returns early if no plan exists in DB. Only user action creates it.
2. **Gemini response truncation** — always join all parts: `parts.map(p => p.text ?? '').join('')`
3. **Zone system mismatch** — Garmin zones (% max HR) vs LTHR-based custom zones have slightly different boundaries. Thresholds in `classifyExecution` use generous margins.
4. **timeInZones storage** — stored as JSON string in DB (`"[12,34,56,78,90]"`), always use `parseZones()` helper in `gemini.service.ts` to handle both string and array forms.
5. **`getStoredRecommendation()` can return null** even right after `updatePlanEntryStatus()` (JSON parse failure or race). Always use optional chaining: `updated?.weeklyPlan`.
6. **Preferred days plural key** — new key is `preferred_long_ride_days` (comma-separated). Legacy key `preferred_long_ride_day` is read as fallback but never written.
7. **UI language** — always English only. Variable names, DB keys, logs can be Dutch/English but all user-visible text must be English.
8. **AI branding** — all user-facing text says "AI", not "Gemini" (the underlying model may change in the future). Internal variable names, DB keys, and log prefixes keep "gemini" for clarity.
9. **`setupComplete` comes from DB** — loaded via `fetchGeminiKeyStatus()` response (`data.setupComplete`). Do not use localStorage.
10. **WAL mode** — SQLite is opened with `db.pragma('journal_mode = WAL')` for better concurrent reads.
