import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import axios from 'axios';
import { getGarminClient, trySessionAuth, invalidateAuthCache } from './services/garmin.service';
import { GarminSSOClient } from './services/sso.service';
import { finalizeLogin } from './services/garmin.service';
import { loadProfile, saveProfile, calculateDefaultZones } from './services/profile.service';
import { fetchCyclingActivities, assessProgression, fetchAndStoreRecentFeedback } from './services/activity.service';
import { syncAndScheduleWorkouts } from './services/workout.service';
import {
  upsertActivities,
  getStoredActivities,
  upsertAnalysis,
  getStoredAnalysis,
  upsertProfileDB,
  getStoredProfile,
  getSetting,
  setSetting,
  getStoredRecommendation,
  updatePlanEntryStatus,
  swapPlanEntryDates
} from './services/database.service';
import {
  generateRecommendation,
  getGeminiKey,
  maskKey,
  classifyCompletedEntries,
  detectAutoSkippedEntries
} from './services/gemini.service';
import { UserHRProfile } from './types';
import { localDate, APP_NAME } from './utils';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Serve static files from the Vue build output
const frontendPath = path.join(__dirname, '../../frontend/dist');
app.use(express.static(frontendPath));

// ── Helpers ───────────────────────────────────────────────────────────────────

const getBearerToken = (): string | null => {
  const client = getGarminClient();
  return (client.client as any).oauth2Token?.access_token ?? null;
};

const garminApi = async (apiPath: string) => {
  const token = getBearerToken();
  if (!token) throw new Error('No active Garmin session.');
  const response = await axios.get(`https://connectapi.garmin.com${apiPath}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return response.data;
};

// Returns the active HR profile: DB → config.json fallback → defaults
const getActiveProfile = async (): Promise<UserHRProfile> => {
  const dbProfile = getStoredProfile();
  if (dbProfile) return dbProfile;

  // Fallback: load from config.json and migrate to DB
  const fileProfile = loadProfile();
  upsertProfileDB(fileProfile);
  return fileProfile;
};

// ── On-startup migration: move config.json profile to DB if DB is empty ───────
(async () => {
  try {
    if (!getStoredProfile()) {
      const fileProfile = loadProfile();
      if (fileProfile) {
        upsertProfileDB(fileProfile);
        console.log('[DB] Migrated profile from config.json to database.');
      }
    }
  } catch (e) {
    console.warn('[DB] Profile migration skipped:', e);
  }
})();

// ── Auth ──────────────────────────────────────────────────────────────────────

const ssoClients = new Map<string, GarminSSOClient>();

app.get('/api/status', async (req: Request, res: Response) => {
  try {
    const sessionValid = await trySessionAuth();
    res.json({ loggedIn: sessionValid });
  } catch {
    res.json({ loggedIn: false });
  }
});

app.post('/api/logout', (_req: Request, res: Response) => {
  invalidateAuthCache();
  console.log('[Auth] User logged out — session invalidated');
  res.json({ loggedOut: true });
});

app.post('/api/login', async (req: Request, res: Response) => {
  const { username, password } = req.body;
  const maskedUser = username ? username.replace(/(?<=.).(?=.*@)/g, '*') : '(unknown)';
  console.log(`[Auth] Login attempt: ${maskedUser}`);
  try {
    const ssoClient = new GarminSSOClient();
    const result = await ssoClient.initiate(username, password);

    if ('mfaRequired' in result) {
      ssoClients.set('last', ssoClient);
      console.log(`[Auth] MFA required for ${maskedUser}`);
      return res.json({ mfaRequired: true });
    }
    if ('success' in result && result.ticket) {
      await finalizeLogin(result.ticket, ssoClient);
      console.log(`[Auth] Login successful: ${maskedUser}`);
      return res.json({ success: true });
    }
    console.warn(`[Auth] Login failed: ${maskedUser}`);
    res.status(401).json({ error: 'Login failed.' });
  } catch (error: any) {
    console.error(`[Auth] Login error for ${maskedUser}:`, error.message);
    res.status(401).json({ error: 'Authentication failed.', details: error.message });
  }
});

app.post('/api/mfa', async (req: Request, res: Response) => {
  const { code } = req.body;
  const ssoClient = ssoClients.get('last');
  if (!ssoClient) return res.status(400).json({ error: 'No active MFA session.' });

  console.log('[Auth] MFA code submitted');
  try {
    const result = await ssoClient.verify(code);
    if (result.success && result.ticket) {
      await finalizeLogin(result.ticket, ssoClient);
      ssoClients.delete('last');
      console.log('[Auth] MFA verification successful — session established');
      return res.json({ success: true });
    }
    console.warn('[Auth] MFA verification failed — wrong code?');
    res.status(401).json({ error: 'MFA verification failed.' });
  } catch (error: any) {
    console.error('[Auth] MFA error:', error.message);
    res.status(401).json({ error: 'MFA failed.', details: error.message });
  }
});

// ── Dashboard — single endpoint for initial page load ─────────────────────────
// Returns all persisted data (no Garmin call). Fast, always works offline.
app.get('/api/dashboard', async (req: Request, res: Response) => {
  try {
    const activities = getStoredActivities();
    const analysis   = getStoredAnalysis();
    const profile    = await getActiveProfile();
    res.json({ activities, analysis, profile });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to load dashboard data.', details: error.message });
  }
});

// ── Profile ───────────────────────────────────────────────────────────────────

app.get('/api/profile', async (req: Request, res: Response) => {
  try {
    const profile = await getActiveProfile();

    // If not customised yet, try to enrich from Garmin user settings
    if (!profile.hasCustomOverrides && getBearerToken()) {
      try {
        const settings   = await garminApi('/userprofile-service/userprofile/user-settings/');
        const garminMaxHr = settings?.userData?.maxHrBpm;
        if (garminMaxHr && garminMaxHr > 100) {
          profile.maxHr = garminMaxHr;
          profile.lthr  = Math.round(garminMaxHr * 0.87);
          profile.zones = calculateDefaultZones(profile.lthr, profile.maxHr);
          upsertProfileDB(profile);
          console.log(`[Profile] Synced maxHR=${garminMaxHr} from Garmin.`);
        }
      } catch { /* non-fatal */ }
    }

    res.json(profile);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to load profile.', details: error.message });
  }
});

app.post('/api/profile', async (req: Request, res: Response) => {
  const { maxHr, lthr, zones } = req.body;
  if (!maxHr || !lthr || !zones) {
    return res.status(400).json({ error: 'maxHr, lthr, and zones are required.' });
  }

  const profile: UserHRProfile = {
    maxHr, lthr, zones,
    hasCustomOverrides: true,
    lastUpdated: new Date().toISOString()
  };

  upsertProfileDB(profile);
  saveProfile(profile); // keep config.json in sync for backward compat
  console.log(`[Profile] Saved — maxHR: ${maxHr} bpm, LTHR: ${lthr} bpm, zones: Z1≤${zones.z1?.max} Z2≤${zones.z2?.max} Z3≤${zones.z3?.max} Z4≤${zones.z4?.max} Z5≤${maxHr}`);
  res.json({ success: true, profile });
});

// ── Activities ────────────────────────────────────────────────────────────────

// Return stored activities + analysis (no Garmin call)
app.get('/api/activities', async (req: Request, res: Response) => {
  try {
    const activities = getStoredActivities();
    const analysis   = getStoredAnalysis();
    const profile    = await getActiveProfile();
    res.json({ activities, analysis, currentProfile: profile });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to load activities.', details: error.message });
  }
});

// ── Shared activity sync helper ───────────────────────────────────────────────
//
// Pulls fresh cycling activities from Garmin, updates DB + analysis, and
// classifies any newly-completed plan entries.  Must be called before every
// generateRecommendation() so the AI always works with up-to-date ride data.
//
// Returns true on success, false when not authenticated or Garmin API fails.
// Never throws — callers may proceed with existing DB data on failure.

const syncActivitiesFromGarmin = async (): Promise<boolean> => {
  try {
    const isAuthenticated = await trySessionAuth();
    if (!isAuthenticated) {
      console.log('[Sync] Not authenticated with Garmin — skipping activity sync');
      return false;
    }

    const prevCount = getStoredActivities().length;
    console.log(`[Sync] Fetching cycling activities from Garmin (currently ${prevCount} stored)…`);
    const freshActivities = await fetchCyclingActivities(365);
    upsertActivities(freshActivities);
    const newCount = getStoredActivities().length - prevCount;
    console.log(`[Sync] Fetched ${freshActivities.length} from Garmin → ${newCount > 0 ? `+${newCount} new` : 'no new'} (${getStoredActivities().length} total stored)`);

    // Fetch RPE + feeling from per-activity detail endpoint — awaited so the AI
    // always has the complete picture before generateRecommendation() is called.
    await fetchAndStoreRecentFeedback(getStoredActivities());

    // Re-run assessment (last 90 days)
    const allStored = getStoredActivities();
    const cutoff    = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
    const recentForAnalysis = allStored.filter(a =>
      a.startTime ? new Date(a.startTime) >= cutoff : true
    );
    const analysis = assessProgression(recentForAnalysis);
    upsertAnalysis(analysis);
    console.log(`[Sync] Analysis: ${analysis.totalCyclingRides} rides (90d), peak HR ${analysis.maxRecordedHr} bpm, est. LTHR ${analysis.estimatedLthr} bpm, avg ${analysis.averageRideDurationMinutes} min`);

    // Classify completed plan entries so statuses are current before AI generation
    const stored = getStoredRecommendation();
    if (stored?.weeklyPlan) {
      const classified = classifyCompletedEntries(stored.weeklyPlan);
      if (classified.length > 0) {
        const summary = classified.map(c => `${c.date}:${c.status}`).join(', ');
        console.log(`[Sync] Classified ${classified.length} workout(s): ${summary}`);
        classified.forEach(({ date, status }) => updatePlanEntryStatus(date, status));
      }
    }

    return true;
  } catch (err: any) {
    console.warn('[Sync] Garmin activity sync failed:', err.message);
    return false;
  }
};

// Pull fresh data from Garmin, merge into DB, re-run analysis
app.post('/api/activities/refresh', async (req: Request, res: Response) => {
  try {
    const isAuthenticated = await trySessionAuth();
    if (!isAuthenticated) {
      return res.status(401).json({ error: 'Not authenticated with Garmin Connect.' });
    }

    // Capture which dates were 'planned' BEFORE syncing — syncActivitiesFromGarmin()
    // calls classifyCompletedEntries() internally and flips their status to 'completed',
    // so a second call after sync would always return empty (they're no longer 'planned').
    const preSyncPlan    = getStoredRecommendation()?.weeklyPlan || [];
    const prePlannedDates = new Set(
      preSyncPlan.filter((e: any) => e.status === 'planned').map((e: any) => e.date)
    );

    // syncActivitiesFromGarmin handles fetch → upsert → analysis → classify
    await syncActivitiesFromGarmin();

    // Non-blocking: trigger AI regen if any previously-planned dates are now 'completed'
    let planRegenTriggered = false;
    const stored = getStoredRecommendation();
    if (stored?.weeklyPlan && prePlannedDates.size > 0) {
      const newlyCompleted = stored.weeklyPlan.filter(
        (e: any) => e.status === 'completed' && prePlannedDates.has(e.date)
      );
      if (newlyCompleted.length > 0) {
        console.log(`[Gemini] ${newlyCompleted.length} newly completed workout(s) (${newlyCompleted.map((e: any) => e.date).join(', ')}) — triggering AI re-evaluation`);
        generateRecommendation(stored.weeklyPlan).catch((err: any) =>
          console.warn('[Gemini] Auto-regen after activity sync failed:', err.message)
        );
        planRegenTriggered = true;
      } else {
        console.log('[Gemini] Activity sync: no newly completed workouts detected in current plan');
      }
    }

    const profile = await getActiveProfile();
    res.json({
      activities:        getStoredActivities(),
      analysis:          getStoredAnalysis(),
      currentProfile:    profile,
      planRegenTriggered,
    });
  } catch (error: any) {
    console.error('[Refresh] Error:', error);
    res.status(error.message.includes('authenticated') ? 401 : 500).json({
      error: 'Failed to refresh activities.',
      details: error.message
    });
  }
});

// ── Sync Workouts ─────────────────────────────────────────────────────────────

app.post('/api/sync-workouts', async (req: Request, res: Response) => {
  const { scheduleDate } = req.body;
  try {
    const rec = getStoredRecommendation();
    const result = await syncAndScheduleWorkouts(rec?.weeklyPlan, scheduleDate);
    res.json({ success: true, ...result });
  } catch (error: any) {
    res.status(error.message.includes('authenticated') ? 401 : 500).json({
      error: 'Failed to create or schedule workouts.',
      details: error.message
    });
  }
});

// ── Gemini Settings ───────────────────────────────────────────────────────────

app.get('/api/settings/gemini-key', (_req: Request, res: Response) => {
  const key           = getGeminiKey();
  const setupComplete = getSetting('setup_complete') === '1';
  const geminiModel   = getSetting('gemini_model') || 'gemini-3.5-flash';

  // Preferred long ride days — read from plural key, fall back to legacy singular key
  const rawDays = getSetting('preferred_long_ride_days') || getSetting('preferred_long_ride_day') || '';
  const preferredLongRideDays = rawDays
    ? rawDays.split(',').map((d: string) => d.trim()).filter(Boolean)
    : [];

  res.json({
    hasKey:               !!key,
    maskedKey:            key ? maskKey(key) : null,
    setupComplete,
    preferredLongRideDays,
    geminiModel
  });
});

// Multi-day preferred long ride days (replaces the old single-day endpoint)
app.post('/api/settings/preferred-long-ride-days', (req: Request, res: Response) => {
  const { days } = req.body;
  if (!Array.isArray(days)) {
    return res.status(400).json({ error: 'days must be an array.' });
  }
  const valid = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const invalid = (days as string[]).find(d => !valid.includes(d));
  if (invalid) return res.status(400).json({ error: `Invalid day: ${invalid}` });

  const value = (days as string[]).join(',');
  setSetting('preferred_long_ride_days', value);
  console.log(`[Settings] Preferred long ride days set to: ${value || '(none)'}`);
  res.json({ saved: true });
});

app.post('/api/settings/gemini-model', (req: Request, res: Response) => {
  const { model } = req.body;
  if (!model || typeof model !== 'string' || !model.trim()) {
    return res.status(400).json({ error: 'model is required.' });
  }
  setSetting('gemini_model', model.trim());
  console.log(`[Settings] Gemini model set to: ${model.trim()}`);
  res.json({ saved: true });
});

app.post('/api/settings/gemini-key', (req: Request, res: Response) => {
  const { apiKey } = req.body;
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    return res.status(400).json({ error: 'apiKey is required.' });
  }
  setSetting('gemini_api_key', apiKey.trim());
  setSetting('gemini_last_generated', '0'); // force regen on next check
  console.log(`[Gemini] API key saved (${maskKey(apiKey.trim())}) — will generate plan on next check`);
  res.json({ saved: true });
});

app.post('/api/settings/setup-complete', (_req: Request, res: Response) => {
  setSetting('setup_complete', '1');
  console.log('[Setup] Setup marked complete — user confirmed HR profile');
  res.json({ saved: true });
});

// ── Recommendation ────────────────────────────────────────────────────────────

app.get('/api/recommendation', (_req: Request, res: Response) => {
  const key = getGeminiKey();
  if (!key) return res.json({ notConfigured: true });

  const rec = getStoredRecommendation();
  if (!rec) return res.json({ noData: true });

  const ageMs = Date.now() - new Date(rec.generatedAt).getTime();
  const stale = ageMs > 23 * 60 * 60 * 1000;

  res.json({ ...rec, stale });
});

/** Extract the human-readable message from a Gemini API error response. */
const geminiErrorMessage = (error: any): string =>
  error.response?.data?.error?.message || error.message || 'Unknown error';

/** Map an error from Gemini/axios to a structured HTTP response. */
const handleGeminiError = (res: Response, error: any, context: string): void => {
  if (error.message === 'GEMINI_KEY_NOT_CONFIGURED') {
    res.status(400).json({ error: 'Gemini API key not configured.' });
    return;
  }
  const httpStatus = error.response?.status;
  if (httpStatus === 429) {
    const msg = geminiErrorMessage(error);
    console.warn(`[Gemini] ${context}: 429 — ${msg}`);
    res.status(429).json({ error: 'Gemini quota exceeded.', details: msg });
    return;
  }
  const msg = geminiErrorMessage(error);
  console.error(`[Gemini] ${context}:`, msg);
  res.status(500).json({ error: 'Failed to generate recommendation.', details: msg });
};

app.post('/api/recommendation/refresh', async (req: Request, res: Response) => {
  try {
    // Always sync activities first so the AI works with current ride data
    await syncActivitiesFromGarmin();

    const current = getStoredRecommendation();
    if (current) {
      const planSummary = current.weeklyPlan.map((e: any) => `${e.date}:${e.type}[${e.status}]`).join(' ');
      console.log(`[Gemini] Manual refresh requested — current plan: ${planSummary}`);
    } else {
      console.log('[Gemini] Manual refresh requested — no existing plan');
    }
    const result = await generateRecommendation(current?.weeklyPlan);
    setSetting('gemini_last_generated', new Date().toISOString());
    res.json(result);
  } catch (error: any) {
    handleGeminiError(res, error, 'Refresh error');
  }
});

app.post('/api/recommendation/skip-today', async (req: Request, res: Response) => {
  try {
    // Sync first so the AI sees the latest rides before re-planning
    await syncActivitiesFromGarmin();

    const today = localDate();
    const stored = getStoredRecommendation();
    const todayEntry = stored?.weeklyPlan?.find((e: any) => e.date === today);
    console.log(`[Gemini] Skip-today: marking ${today} as skipped (was: ${todayEntry?.type ?? 'unknown'} [${todayEntry?.status ?? 'unknown'}])`);
    updatePlanEntryStatus(today, 'skipped');
    const updated = getStoredRecommendation();
    const result  = await generateRecommendation(updated?.weeklyPlan);
    setSetting('gemini_last_generated', new Date().toISOString());
    res.json(result);
  } catch (error: any) {
    handleGeminiError(res, error, 'Skip-today error');
  }
});

app.post('/api/recommendation/reschedule', async (req: Request, res: Response) => {
  try {
    const { fromDate, toDate } = req.body;
    if (!fromDate || !toDate) {
      return res.status(400).json({ error: 'fromDate and toDate are required.' });
    }
    if (fromDate === toDate) {
      return res.status(400).json({ error: 'fromDate and toDate must be different.' });
    }

    // Sync first so the AI re-plans with current ride data
    await syncActivitiesFromGarmin();

    const swapped = swapPlanEntryDates(fromDate, toDate);
    if (!swapped) {
      return res.status(404).json({ error: 'One or both dates not found in the current plan.' });
    }

    console.log(`[Plan] Rescheduled: swapped ${fromDate} ↔ ${toDate}`);

    // Re-evaluate with the updated plan so the AI adjusts the rest of the week
    const updated = getStoredRecommendation();
    const result  = await generateRecommendation(updated?.weeklyPlan);
    setSetting('gemini_last_generated', new Date().toISOString());
    res.json(result);
  } catch (error: any) {
    handleGeminiError(res, error, 'Reschedule error');
  }
});

// ── Debug — raw Garmin activity fields (discover perceivedExertion / feeling) ─
// Hit GET /api/debug/raw-activity after syncing to inspect both the list AND detail
// API responses and find the exact field names for RPE + post-ride feeling.
app.get('/api/debug/raw-activity', async (_req: Request, res: Response) => {
  try {
    const isAuthenticated = await trySessionAuth();
    if (!isAuthenticated) return res.status(401).json({ error: 'Not authenticated.' });
    const client = getGarminClient();
    const acts   = await client.getActivities(0, 10);
    const cycling = acts.filter((a: any) => {
      const t = (a.activityType?.typeKey || '').toLowerCase();
      return t.includes('cycl') || t.includes('bik');
    });
    const first = cycling[0] ?? acts[0];
    if (!first) return res.json({ message: 'No activities found' });

    // ── 1. List-endpoint fields ──────────────────────────────────────────────
    const listFields: Record<string, any> = {};
    for (const [k, v] of Object.entries(first as object)) {
      if (v != null) listFields[k] = v;
    }

    // ── 2. Detail endpoint — may contain perceivedExertion when list does not ─
    let detailFields: Record<string, any> = {};
    let detailSummaryDTO: Record<string, any> = {};
    try {
      const detail = await client.getActivity({ activityId: (first as any).activityId }) as any;
      for (const [k, v] of Object.entries(detail)) {
        if (v != null && typeof v !== 'object') detailFields[k] = v;
      }
      // summaryDTO contains additional stats
      if (detail.summaryDTO) {
        for (const [k, v] of Object.entries(detail.summaryDTO as object)) {
          if (v != null) detailSummaryDTO[k] = v;
        }
      }
    } catch (e: any) {
      detailFields = { error: `getActivity failed: ${e.message}` };
    }

    const TARGET_FIELDS = ['perceivedExertion', 'feelingAfterExercise', 'activityFeedback',
                           'userTrainingFeedback', 'feedbackPhrase', 'trainingFeedback',
                           'effort', 'effortFeedback', 'perceivedEffort'];

    res.json({
      activityName:         (first as any).activityName,
      activityId:           (first as any).activityId,
      // Quick scan — what we care about across both sources
      targetFieldsInList:   Object.fromEntries(TARGET_FIELDS.map(f => [f, listFields[f] ?? '(absent)'])),
      targetFieldsInDetail: Object.fromEntries(TARGET_FIELDS.map(f => [f, detailFields[f] ?? detailSummaryDTO[f] ?? '(absent)'])),
      // Full dumps for discovering any other relevant field names
      listNonNullFields:    listFields,
      detailNonNullScalars: detailFields,
      detailSummaryDTO,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Gemini Auto-check (hourly) ────────────────────────────────────────────────

const logAutoCheckState = () => {
  const stored    = getStoredRecommendation();
  const lastGenStr = getSetting('gemini_last_generated');
  const ageMs     = Date.now() - (lastGenStr && lastGenStr !== '0' ? new Date(lastGenStr).getTime() : 0);
  const ageHours  = (ageMs / 3600000).toFixed(1);

  if (!stored) {
    console.log(`[Gemini] Auto-check state: no plan in DB, last_generated=${lastGenStr ?? 'never'}`);
    return;
  }

  const planLine = stored.weeklyPlan
    .map((e: any) => `${e.date}:${e.type[0]}[${e.status[0]}]`)
    .join(' ');
  console.log(`[Gemini] Auto-check state: plan age ${ageHours}h, fatigue=${stored.loadAssessment?.fatigue ?? '?'}`);
  console.log(`[Gemini] Plan: ${planLine}`);
};

const runGeminiAutoCheck = async () => {
  logAutoCheckState();
  try {
    const key = getGeminiKey();
    if (!key) {
      console.log('[Gemini] Auto-check: no API key configured — skipping');
      return;
    }

    // Sync activities first — auto-skip detection depends on having current ride data
    console.log('[Gemini] Auto-check: syncing activities from Garmin before evaluation…');
    await syncActivitiesFromGarmin();

    // Detect auto-skips (planned days that passed with no activity)
    const stored = getStoredRecommendation();
    if (stored?.weeklyPlan) {
      const autoSkips = detectAutoSkippedEntries(stored.weeklyPlan);
      if (autoSkips.length > 0) {
        console.log(`[Gemini] Auto-check: ${autoSkips.length} auto-skip(s) detected (${autoSkips.join(', ')}) — marking and regenerating`);
        autoSkips.forEach(date => updatePlanEntryStatus(date, 'auto-skipped'));
        const updated = getStoredRecommendation();
        await generateRecommendation(updated?.weeklyPlan);
        setSetting('gemini_last_generated', new Date().toISOString());
        return; // already regenerated
      }
    }

    // Standard daily freshness check — only regenerate if a plan already exists.
    // The very first plan must be initiated by the user via the "Generate my first plan" button.
    const current = getStoredRecommendation();
    if (!current) {
      console.log('[Gemini] Auto-check: no plan in DB — waiting for user to generate first plan');
      return;
    }

    const lastGenStr = getSetting('gemini_last_generated');
    const ageMs      = Date.now() - (lastGenStr && lastGenStr !== '0' ? new Date(lastGenStr).getTime() : 0);
    if (ageMs > 23 * 60 * 60 * 1000) {
      console.log(`[Gemini] Auto-check: regenerating — plan is ${(ageMs / 3600000).toFixed(1)}h old (> 23h)`);
      await generateRecommendation(current.weeklyPlan);
      setSetting('gemini_last_generated', new Date().toISOString());
    } else {
      console.log(`[Gemini] Auto-check: plan is fresh (${(ageMs / 3600000).toFixed(1)}h old) — no regen needed`);
    }
  } catch (err: any) {
    if (err.response?.status === 429) {
      // Stamp now so the 23h freshness check doesn't retry on next server restart
      setSetting('gemini_last_generated', new Date().toISOString());
      console.warn('[Gemini] Auto-check: 429 —', geminiErrorMessage(err), '— backed off for 23h');
    } else {
      console.warn('[Gemini] Auto-check failed:', geminiErrorMessage(err));
    }
  }
};

runGeminiAutoCheck();
setInterval(runGeminiAutoCheck, 60 * 60 * 1000);

// ── Start ─────────────────────────────────────────────────────────────────────

// SPA catch-all: serve index.html for any non-API route (Vue Router history mode)
app.get('*', (_req: Request, res: Response) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

app.listen(PORT, () => {
  const line = '─'.repeat(52);
  const profile   = getStoredProfile();
  const acts      = getStoredActivities();
  const rec       = getStoredRecommendation();
  const geminiKey = getGeminiKey();
  const setup     = getSetting('setup_complete') === '1';
  const lastGen   = getSetting('gemini_last_generated');

  console.log(`\n┌${line}┐`);
  console.log(`│  ${APP_NAME} backend    ·  http://localhost:${PORT}${' '.repeat(8)}│`);
  console.log(`├${line}┤`);
  console.log(`│  Garmin profile : maxHR ${profile?.maxHr ?? '?'} bpm, LTHR ${profile?.lthr ?? '?'} bpm${' '.repeat(Math.max(0, 11 - String(profile?.maxHr ?? '?').length - String(profile?.lthr ?? '?').length))}│`);
  console.log(`│  Activities     : ${acts.length} stored${' '.repeat(Math.max(0, 33 - String(acts.length).length))}│`);
  console.log(`│  Setup complete : ${setup ? 'yes' : 'no'}${' '.repeat(setup ? 38 : 37)}│`);
  console.log(`│  Gemini key     : ${geminiKey ? maskKey(geminiKey) : 'not configured'}${' '.repeat(Math.max(0, 32 - (geminiKey ? maskKey(geminiKey).length : 14)))}│`);
  console.log(`│  Last generated : ${lastGen && lastGen !== '0' ? lastGen : 'never'}${' '.repeat(Math.max(0, 32 - (lastGen && lastGen !== '0' ? lastGen.length : 5)))}│`);
  console.log(`│  Plan in DB     : ${rec ? `yes — ${rec.workoutType} (${rec.loadAssessment?.fatigue} fatigue)` : 'none'}${' '.repeat(Math.max(0, rec ? 28 - rec.workoutType.length - (rec.loadAssessment?.fatigue?.length ?? 0) : 33))}│`);
  console.log(`└${line}┘\n`);
});
