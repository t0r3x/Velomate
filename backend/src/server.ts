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
import logger from './logger';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 2012;

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
        logger.info('[DB] Migrated profile from config.json to database.');
      }
    }
  } catch (e) {
    logger.warn('[DB] Profile migration skipped: ' + JSON.stringify(e));
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
  logger.info('[Auth] User logged out — session invalidated');
  res.json({ loggedOut: true });
});

app.post('/api/login', async (req: Request, res: Response) => {
  const { username, password } = req.body;
  const maskedUser = username ? username.replace(/(?<=.).(?=.*@)/g, '*') : '(unknown)';
  logger.info(`[Auth] Login attempt: ${maskedUser}`);
  try {
    const ssoClient = new GarminSSOClient();
    const result = await ssoClient.initiate(username, password);

    if ('mfaRequired' in result) {
      ssoClients.set('last', ssoClient);
      logger.info(`[Auth] MFA required for ${maskedUser}`);
      return res.json({ mfaRequired: true });
    }
    if ('success' in result && result.ticket) {
      await finalizeLogin(result.ticket, ssoClient);
      logger.info(`[Auth] Login successful: ${maskedUser}`);
      return res.json({ success: true });
    }
    logger.warn(`[Auth] Login failed: ${maskedUser}`);
    res.status(401).json({ error: 'Login failed.' });
  } catch (error: any) {
    logger.error(`[Auth] Login error for ${maskedUser}: ${error.message}`);
    res.status(401).json({ error: 'Authentication failed.', details: error.message });
  }
});

app.post('/api/mfa', async (req: Request, res: Response) => {
  const { code } = req.body;
  const ssoClient = ssoClients.get('last');
  if (!ssoClient) return res.status(400).json({ error: 'No active MFA session.' });

  logger.info('[Auth] MFA code submitted');
  try {
    const result = await ssoClient.verify(code);
    if (result.success && result.ticket) {
      await finalizeLogin(result.ticket, ssoClient);
      ssoClients.delete('last');
      logger.info('[Auth] MFA verification successful — session established');
      return res.json({ success: true });
    }
    logger.warn('[Auth] MFA verification failed — wrong code?');
    res.status(401).json({ error: 'MFA verification failed.' });
  } catch (error: any) {
    logger.error(`[Auth] MFA error: ${error.message}`);
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
          logger.info(`[Profile] Synced maxHR=${garminMaxHr} from Garmin.`);
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
  logger.info(`[Profile] Saved — maxHR: ${maxHr} bpm, LTHR: ${lthr} bpm, zones: Z1≤${zones.z1?.max} Z2≤${zones.z2?.max} Z3≤${zones.z3?.max} Z4≤${zones.z4?.max} Z5≤${maxHr}`);
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
      logger.info('[Sync] Not authenticated with Garmin — skipping activity sync');
      return false;
    }

    const prevCount = getStoredActivities().length;
    logger.info(`[Sync] Fetching cycling activities from Garmin (currently ${prevCount} stored)…`);
    const freshActivities = await fetchCyclingActivities(365);
    upsertActivities(freshActivities);
    const newCount = getStoredActivities().length - prevCount;
    logger.info(`[Sync] Fetched ${freshActivities.length} from Garmin → ${newCount > 0 ? `+${newCount} new` : 'no new'} (${getStoredActivities().length} total stored)`);

    // Fetch RPE + feeling from per-activity detail endpoint — awaited so the AI
    // always has the complete picture before generateRecommendation() is called.
    await fetchAndStoreRecentFeedback(getStoredActivities());

    // Re-run assessment: 90-day window for ride count/duration stats,
    // but all stored activities for peak HR so older hard efforts aren't lost.
    const allStored = getStoredActivities();
    const cutoff    = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
    const recentForAnalysis = allStored.filter(a =>
      a.startTime ? new Date(a.startTime) >= cutoff : true
    );
    const analysis = assessProgression(recentForAnalysis);
    upsertAnalysis(analysis);
    logger.info(`[Sync] Analysis: ${analysis.totalCyclingRides} rides (90d), peak HR ${analysis.maxRecordedHr} bpm, est. LTHR ${analysis.estimatedLthr} bpm, avg ${analysis.averageRideDurationMinutes} min`);

    // Classify completed plan entries so statuses are current before AI generation
    const stored = getStoredRecommendation();
    if (stored?.weeklyPlan) {
      const classified = classifyCompletedEntries(stored.weeklyPlan);
      if (classified.length > 0) {
        const summary = classified.map(c => `${c.date}:${c.status}`).join(', ');
        logger.info(`[Sync] Classified ${classified.length} workout(s): ${summary}`);
        classified.forEach(({ date, status }) => updatePlanEntryStatus(date, status));
        setSetting('last_plan_activity_date', localDate());
      }
    }

    return true;
  } catch (err: any) {
    logger.warn(`[Sync] Garmin activity sync failed: ${err.message}`);
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
        logger.info(`[Gemini] ${newlyCompleted.length} newly completed workout(s) (${newlyCompleted.map((e: any) => e.date).join(', ')}) — triggering AI re-evaluation`);
        generateRecommendation(stored.weeklyPlan).catch((err: any) =>
          logger.warn(`[Gemini] Auto-regen after activity sync failed: ${err.message}`)
        );
        planRegenTriggered = true;
      } else {
        logger.info('[Gemini] Activity sync: no newly completed workouts detected in current plan');
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
    logger.error(`[Refresh] Error: ${JSON.stringify(error)}`);
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

  const inactivityPauseDays = parseInt(getSetting('inactivity_pause_days') || '14', 10) || 14;

  res.json({
    hasKey:               !!key,
    maskedKey:            key ? maskKey(key) : null,
    setupComplete,
    preferredLongRideDays,
    geminiModel,
    inactivityPauseDays
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
  logger.info(`[Settings] Preferred long ride days set to: ${value || '(none)'}`);
  res.json({ saved: true });
});

app.post('/api/settings/inactivity-pause-days', (req: Request, res: Response) => {
  const { days } = req.body;
  const parsed = parseInt(days, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 365) {
    return res.status(400).json({ error: 'days must be an integer between 1 and 365.' });
  }
  setSetting('inactivity_pause_days', String(parsed));
  logger.info(`[Settings] Inactivity pause threshold set to: ${parsed} days`);
  res.json({ saved: true });
});

app.post('/api/settings/gemini-model', (req: Request, res: Response) => {
  const { model } = req.body;
  if (!model || typeof model !== 'string' || !model.trim()) {
    return res.status(400).json({ error: 'model is required.' });
  }
  setSetting('gemini_model', model.trim());
  logger.info(`[Settings] Gemini model set to: ${model.trim()}`);
  res.json({ saved: true });
});

app.post('/api/settings/gemini-key', (req: Request, res: Response) => {
  const { apiKey } = req.body;
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    return res.status(400).json({ error: 'apiKey is required.' });
  }
  setSetting('gemini_api_key', apiKey.trim());
  setSetting('gemini_last_generated', '0'); // force regen on next check
  logger.info(`[Gemini] API key saved (${maskKey(apiKey.trim())}) — will generate plan on next check`);
  res.json({ saved: true });
});

app.delete('/api/settings/gemini-key', (_req: Request, res: Response) => {
  setSetting('gemini_api_key', '');
  logger.info('[Gemini] API key removed');
  res.json({ removed: true });
});

app.post('/api/settings/setup-complete', (_req: Request, res: Response) => {
  setSetting('setup_complete', '1');
  logger.info('[Setup] Setup marked complete — user confirmed HR profile');
  res.json({ saved: true });
});

app.get('/api/settings/training-goals', (_req: Request, res: Response) => {
  res.json({ goals: getSetting('user_goals') || '' });
});

app.post('/api/settings/training-goals', (req: Request, res: Response) => {
  const { goals } = req.body;
  if (typeof goals !== 'string') {
    return res.status(400).json({ error: 'goals must be a string.' });
  }
  setSetting('user_goals', goals.slice(0, 500));
  logger.info('[Settings] Training goals updated');
  res.json({ saved: true });
});

// ── Training pause ────────────────────────────────────────────────────────────

app.post('/api/training/pause', (req: Request, res: Response) => {
  const { reason } = req.body;
  const pausedSince = new Date().toISOString();
  setSetting('training_paused', '1');
  setSetting('paused_since', pausedSince);
  setSetting('pause_reason', reason || '');
  logger.info(`[Training] Paused — since ${pausedSince}${reason ? `, reason: ${reason}` : ''}`);
  res.json({ paused: true, pausedSince, pauseReason: reason || '' });
});

app.post('/api/training/resume', async (req: Request, res: Response) => {
  const pausedSince = getSetting('paused_since') || '';
  const pauseReason = getSetting('pause_reason') || '';

  // Count rides during the pause period to pass context to AI
  let activitiesCount = 0;
  if (pausedSince) {
    const allActs = getStoredActivities();
    activitiesCount = allActs.filter(a =>
      a.startTime && a.startTime >= pausedSince
    ).length;
  }

  // Clear pause flags first so AI generation can proceed
  setSetting('training_paused', '');
  setSetting('paused_since', '');
  setSetting('pause_reason', '');
  // Reset the inactivity clock — the 14-day counter starts fresh from today
  setSetting('last_plan_activity_date', localDate());
  logger.info(`[Training] Resumed — was paused since ${pausedSince || 'unknown'}, ${activitiesCount} ride(s) during pause`);

  // Sync fresh activities, then regenerate plan with pause context
  try {
    const key = getGeminiKey();
    if (key) {
      await syncActivitiesFromGarmin();
      const current = getStoredRecommendation();
      const pauseCtx = pausedSince
        ? { pausedSince: pausedSince.slice(0, 10), pauseReason: pauseReason || undefined, activitiesCount }
        : undefined;
      await generateRecommendation(current?.weeklyPlan, pauseCtx);
      setSetting('gemini_last_generated', new Date().toISOString());
    }
  } catch (err: any) {
    logger.warn(`[Training] Resume: plan regen failed: ${err.message}`);
  }

  res.json({ resumed: true });
});

// ── Recommendation ────────────────────────────────────────────────────────────

app.get('/api/recommendation', (_req: Request, res: Response) => {
  const key = getGeminiKey();
  if (!key) return res.json({ notConfigured: true });

  // Training paused — return paused state
  if (getSetting('training_paused') === '1') {
    return res.json({
      paused:      true,
      pausedSince: getSetting('paused_since') || '',
      pauseReason: getSetting('pause_reason') || ''
    });
  }

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
    logger.warn(`[Gemini] ${context}: 429 — ${msg}`);
    res.status(429).json({ error: 'Gemini quota exceeded.', details: msg });
    return;
  }
  const msg = geminiErrorMessage(error);
  logger.error(`[Gemini] ${context}: ${msg}`);
  res.status(500).json({ error: 'Failed to generate recommendation. Check if the API key is correctly set.', details: msg });
};

app.post('/api/recommendation/refresh', async (req: Request, res: Response) => {
  try {
    if (getSetting('training_paused') === '1') {
      return res.status(403).json({ error: 'Training is paused. Resume training before refreshing the plan.' });
    }
    // Always sync activities first so the AI works with current ride data
    await syncActivitiesFromGarmin();

    const current = getStoredRecommendation();
    if (current) {
      const planSummary = current.weeklyPlan.map((e: any) => `${e.date}:${e.type}[${e.status}]`).join(' ');
      logger.info(`[Gemini] Manual refresh requested — current plan: ${planSummary}`);
    } else {
      logger.info('[Gemini] Manual refresh requested — no existing plan');
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
    if (getSetting('training_paused') === '1') {
      return res.status(403).json({ error: 'Training is paused. Resume training before making changes.' });
    }
    // Sync first so the AI sees the latest rides before re-planning
    await syncActivitiesFromGarmin();

    const today = localDate();
    const date = (req.body?.date && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date)) ? req.body.date : today;
    const stored = getStoredRecommendation();
    const entry = stored?.weeklyPlan?.find((e: any) => e.date === date);
    logger.info(`[Gemini] Skip: marking ${date} as skipped (was: ${entry?.type ?? 'unknown'} [${entry?.status ?? 'unknown'}])`);
    updatePlanEntryStatus(date, 'skipped');
    const updated = getStoredRecommendation();
    try {
      const result = await generateRecommendation(updated?.weeklyPlan);
      setSetting('gemini_last_generated', new Date().toISOString());
      res.json(result);
    } catch (regenError: any) {
      logger.warn(`[Plan] Skip-today regen failed (skip already committed): ${regenError?.message}`);
      res.json({ ...updated, regenFailed: true });
    }
  } catch (error: any) {
    handleGeminiError(res, error, 'Skip-today error');
  }
});

app.post('/api/recommendation/reschedule', async (req: Request, res: Response) => {
  try {
    if (getSetting('training_paused') === '1') {
      return res.status(403).json({ error: 'Training is paused. Resume training before making changes.' });
    }
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

    logger.info(`[Plan] Rescheduled: swapped ${fromDate} ↔ ${toDate}`);

    // Re-evaluate with the updated plan so the AI adjusts the rest of the week
    const updated = getStoredRecommendation();

    // If today was one of the swapped dates, pin its new type so the AI cannot override it.
    const today = localDate();
    const pinnedTodayType = (fromDate === today || toDate === today)
      ? updated?.weeklyPlan?.find((e: any) => e.date === today)?.type
      : undefined;
    if (pinnedTodayType) logger.info(`[Plan] Pinning today's type to "${pinnedTodayType}" after reschedule`);

    try {
      const result = await generateRecommendation(updated?.weeklyPlan, undefined, pinnedTodayType);
      setSetting('gemini_last_generated', new Date().toISOString());
      res.json(result);
    } catch (regenError: any) {
      // Swap succeeded but AI regen failed — return the swapped plan so the UI
      // reflects the move without falsely reporting the whole operation as failed.
      logger.warn(`[Plan] Reschedule regen failed (swap already committed): ${regenError?.message}`);
      res.json({ ...updated, regenFailed: true });
    }
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
    logger.info(`[Gemini] Auto-check state: no plan in DB, last_generated=${lastGenStr ?? 'never'}`);
    return;
  }

  const planLine = stored.weeklyPlan
    .map((e: any) => `${e.date}:${e.type[0]}[${e.status[0]}]`)
    .join(' ');
  logger.info(`[Gemini] Auto-check state: plan age ${ageHours}h, fatigue=${stored.loadAssessment?.fatigue ?? '?'}`);
  logger.info(`[Gemini] Plan: ${planLine}`);
};

const runGeminiAutoCheck = async () => {
  logAutoCheckState();
  try {
    const key = getGeminiKey();
    if (!key) {
      logger.info('[Gemini] Auto-check: no API key configured — skipping');
      return;
    }

    // Skip everything when training is paused
    if (getSetting('training_paused') === '1') {
      logger.info('[Gemini] Auto-check: training paused — skipping auto-check');
      return;
    }

    // Sync activities first — auto-skip detection depends on having current ride data
    logger.info('[Gemini] Auto-check: syncing activities from Garmin before evaluation…');
    await syncActivitiesFromGarmin();

    // Detect auto-skips (planned days that passed with no activity)
    const stored = getStoredRecommendation();
    if (stored?.weeklyPlan) {
      // Don't auto-skip dates that fall within a completed pause period
      const pausedSince = getSetting('paused_since') || '';
      const autoSkips = detectAutoSkippedEntries(stored.weeklyPlan)
        .filter(date => !pausedSince || date < pausedSince.slice(0, 10));
      if (autoSkips.length > 0) {
        logger.info(`[Gemini] Auto-check: ${autoSkips.length} auto-skip(s) detected (${autoSkips.join(', ')}) — marking and regenerating`);
        autoSkips.forEach(date => updatePlanEntryStatus(date, 'auto-skipped'));
        const updated = getStoredRecommendation();
        await generateRecommendation(updated?.weeklyPlan);
        setSetting('gemini_last_generated', new Date().toISOString());
        return; // already regenerated
      }
    }

    // Auto-pause after N consecutive days without any completed workout (default 14, user-configurable).
    // Reference date: last completed workout, or if never, the plan creation date.
    // This naturally handles "plan not yet started" — a brand-new plan won't reach N days yet.
    const inactivityThreshold = parseInt(getSetting('inactivity_pause_days') || '14', 10) || 14;
    const lastActivity = getSetting('last_plan_activity_date');
    const refDate      = lastActivity ?? getSetting('gemini_last_generated');
    if (refDate && refDate !== '0') {
      const daysSince = Math.floor((Date.now() - new Date(refDate).getTime()) / 86_400_000);
      if (daysSince >= inactivityThreshold) {
        setSetting('training_paused', '1');
        setSetting('paused_since', new Date().toISOString());
        setSetting('pause_reason', `Automatically paused after ${inactivityThreshold} days without any training activity.`);
        logger.info(`[Gemini] Auto-check: auto-pausing — ${daysSince} days without activity (threshold: ${inactivityThreshold}, ref: ${refDate})`);
        return;
      }
    }

    // Standard daily freshness check — only regenerate if a plan already exists.
    // The very first plan must be initiated by the user via the "Generate my first plan" button.
    const current = getStoredRecommendation();
    if (!current) {
      logger.info('[Gemini] Auto-check: no plan in DB — waiting for user to generate first plan');
      return;
    }

    const lastGenStr = getSetting('gemini_last_generated');
    const ageMs      = Date.now() - (lastGenStr && lastGenStr !== '0' ? new Date(lastGenStr).getTime() : 0);
    if (ageMs > 23 * 60 * 60 * 1000) {
      logger.info(`[Gemini] Auto-check: regenerating — plan is ${(ageMs / 3600000).toFixed(1)}h old (> 23h)`);
      await generateRecommendation(current.weeklyPlan);
      setSetting('gemini_last_generated', new Date().toISOString());
    } else {
      logger.info(`[Gemini] Auto-check: plan is fresh (${(ageMs / 3600000).toFixed(1)}h old) — no regen needed`);
    }
  } catch (err: any) {
    if (err.response?.status === 429) {
      // Stamp now so the 23h freshness check doesn't retry on next server restart
      setSetting('gemini_last_generated', new Date().toISOString());
      logger.warn(`[Gemini] Auto-check: 429 — ${geminiErrorMessage(err)} — backed off for 23h`);
    } else {
      logger.warn(`[Gemini] Auto-check failed: ${geminiErrorMessage(err)}`);
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
  const profile   = getStoredProfile();
  const acts      = getStoredActivities();
  const rec       = getStoredRecommendation();
  const geminiKey = getGeminiKey();
  const setup     = getSetting('setup_complete') === '1';
  const lastGen   = getSetting('gemini_last_generated');

  logger.info('='.repeat(60));
  logger.info(`${APP_NAME} backend started — listening on :${PORT}`);
  logger.info(`Profile: maxHR ${profile?.maxHr ?? '?'} bpm, LTHR ${profile?.lthr ?? '?'} bpm | Activities: ${acts.length} stored | Setup: ${setup ? 'yes' : 'no'}`);
  logger.info(`Gemini key: ${geminiKey ? maskKey(geminiKey) : 'not configured'} | Last generated: ${lastGen && lastGen !== '0' ? lastGen : 'never'} | Plan: ${rec ? `${rec.workoutType} (${rec.loadAssessment?.fatigue} fatigue)` : 'none'}`);
  logger.info('='.repeat(60));
});
