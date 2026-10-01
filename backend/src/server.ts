import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import axios from 'axios';
import { getGarminClient, trySessionAuth, invalidateAuthCache } from './services/garmin.service';
import { GarminSSOClient } from './services/sso.service';
import { finalizeLogin } from './services/garmin.service';
import { loadProfile, saveProfile, calculateDefaultZones } from './services/profile.service';
import { fetchCyclingActivities, assessProgression, fetchAndStoreRecentFeedback, pushActivityFeedback } from './services/activity.service';
import { syncAndScheduleWorkouts, syncFreeWorkout } from './services/workout.service';
import {
  upsertActivities,
  getStoredActivities,
  updateActivityFeedback,
  upsertCheckin,
  getCheckin,
  deleteCheckin,
  getRecentCheckins,
  upsertAnalysis,
  getStoredAnalysis,
  upsertProfileDB,
  getStoredProfile,
  getSetting,
  setSetting,
  getStoredRecommendation,
  updatePlanEntryStatus,
  swapPlanEntryDates,
  getCurrentFreeSuggestion,
  getFreeSuggestionHistory,
  markFreeSuggestionSynced,
  markFreeSuggestionCompleted,
  markFreeSuggestionDismissed
} from './services/database.service';
import {
  generateRecommendation,
  getGeminiKey,
  maskKey,
  classifyCompletedEntries,
  detectAutoSkippedEntries,
  getGeminiModel,
  normalizeModelId,
  isValidModelId,
  generateFreeSuggestion,
  isFreeTrainingMode,
  findRideForFreeSuggestion,
  isGenerationInFlight
} from './services/gemini.service';
import { UserHRProfile } from './types';
import { localDate, APP_NAME, fromRpe, fromFeeling } from './utils';
import logger from './logger';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 2012;

/**
 * Network interface to listen on.
 *
 * Loopback by default: no API route is authenticated, and Electron only ever talks to
 * 127.0.0.1 (see electron-main.js), so a 0.0.0.0 bind buys nothing and lets anyone on the
 * same network read the athlete's ride history, dump the debug endpoints, overwrite the AI
 * key or push workouts to their Garmin account. Deployments that genuinely need remote
 * access — Docker port mapping, a Pi on the LAN — opt in with BIND_HOST=0.0.0.0.
 */
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';

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

// Garmin's own detected LTHR (userprofile-service) — real per-account data, when available,
// instead of Velomate's ×0.88-of-maxHR guess. Confirmed via /api/debug/garmin-hr-data that
// Garmin does populate this (thresholdHeartRateAutoDetected: true) for at least some accounts.
const fetchGarminLthr = async (): Promise<number | null> => {
  if (!getBearerToken()) return null;
  try {
    const settings = await garminApi('/userprofile-service/userprofile/user-settings/');
    const lthr = settings?.userData?.lactateThresholdHeartRate;
    return typeof lthr === 'number' && lthr > 100 && lthr < 250 ? lthr : null;
  } catch {
    return null; // non-fatal — caller falls back to the estimate
  }
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
  // Dev-only: lets scripts/dev-with-athlete.js open the dashboard straight into a
  // synthetic test athlete's plan, which has no real Garmin session to check against.
  // Only ever set by that script — never touched by electron:build/electron:publish.
  if (process.env.VELOMATE_SKIP_AUTH === '1') {
    res.json({ loggedIn: true });
    return;
  }
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
        const settings    = await garminApi('/userprofile-service/userprofile/user-settings/');
        const garminMaxHr = settings?.userData?.maxHrBpm;
        const garminLthr  = settings?.userData?.lactateThresholdHeartRate;

        let changed = false;
        if (garminMaxHr && garminMaxHr > 100) {
          profile.maxHr = garminMaxHr;
          changed = true;
        }
        // Prefer Garmin's own detected LTHR over the ×0.87 estimate — independent of
        // whether maxHr itself changed (some accounts expose one field but not the other).
        if (typeof garminLthr === 'number' && garminLthr > 100 && garminLthr < profile.maxHr) {
          profile.lthr = garminLthr;
          changed = true;
        } else if (garminMaxHr && garminMaxHr > 100) {
          profile.lthr = Math.round(garminMaxHr * 0.87);
        }

        if (changed) {
          profile.zones = calculateDefaultZones(profile.lthr, profile.maxHr);
          upsertProfileDB(profile);
          logger.info(`[Profile] Synced from Garmin — maxHR=${profile.maxHr}, LTHR=${profile.lthr}${typeof garminLthr === 'number' ? ' (real)' : ' (estimated)'}`);
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

// ── Free training helpers ─────────────────────────────────────────────────────

/**
 * Free-mode equivalent of classifyCompletedEntries(): matches a synced suggestion to the
 * ride that followed it and marks it completed, so the next AI call can score it.
 * Returns the id of the suggestion that just completed, or null when nothing changed.
 */
const settleFreeSuggestion = (): number | null => {
  const current = getCurrentFreeSuggestion();
  if (!current || current.status !== 'synced' || !current.syncedForDate) return null;

  const ride = findRideForFreeSuggestion(current.syncedForDate);
  if (!ride) return null;

  const rideDate = ride.startTime.slice(0, 10);
  markFreeSuggestionCompleted(current.id, rideDate, String(ride.activityId));
  logger.info(`[Free] Suggestion #${current.id} (${current.workoutType}, synced for ${current.syncedForDate}) matched to ride on ${rideDate} — marked completed`);
  return current.id;
};

/** 409 when a request targets the mode the athlete is not currently in. */
const requireMode = (res: Response, wantFree: boolean): boolean => {
  if (isFreeTrainingMode() === wantFree) return true;
  res.status(409).json({
    error: wantFree
      ? 'Free training mode is not enabled.'
      : 'Free training mode is enabled — the weekly plan is inactive.'
  });
  return false;
};

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
    const realLthr = await fetchGarminLthr();
    const analysis = assessProgression(recentForAnalysis, realLthr);
    upsertAnalysis(analysis);
    logger.info(`[Sync] Analysis: ${analysis.totalCyclingRides} rides (90d), peak HR ${analysis.maxRecordedHr} bpm, est. LTHR ${analysis.estimatedLthr} bpm${realLthr ? ' (from Garmin)' : ' (estimated)'}, avg ${analysis.averageRideDurationMinutes} min`);

    if (isFreeTrainingMode()) {
      // Free mode has no dated plan to classify against, so the inactivity clock can't be
      // driven by completed plan entries. Stamp it from the most recent ride instead —
      // otherwise auto-pause would fire on an athlete who is training perfectly well.
      const latestRide = getStoredActivities().find((a: any) => a.startTime)?.startTime?.slice(0, 10);
      if (latestRide && latestRide > (getSetting('last_plan_activity_date') ?? '')) {
        setSetting('last_plan_activity_date', latestRide);
      }
      settleFreeSuggestion();
    } else {
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
    // Same trick for free mode: the sync calls settleFreeSuggestion() internally, which
    // flips a synced suggestion to 'completed' and thus out of getCurrentFreeSuggestion().
    const preSyncFreeId = getCurrentFreeSuggestion()?.id ?? null;
    // Row count before and after is the only honest source for "how many new rides" — the
    // upsert overwrites existing rows silently, so the Garmin payload size says nothing.
    const preSyncActivityCount = getStoredActivities().length;

    // syncActivitiesFromGarmin handles fetch → upsert → analysis → classify
    await syncActivitiesFromGarmin();
    const newCount = Math.max(0, getStoredActivities().length - preSyncActivityCount);

    // Non-blocking: trigger AI regen if any previously-planned dates are now 'completed'
    // (gated by 'instant_score_on_new_activity', default on)
    let planRegenTriggered = false;
    const stored = getStoredRecommendation();
    const instantScoringEnabled = getSetting('instant_score_on_new_activity') !== '0';

    if (isFreeTrainingMode()) {
      // syncActivitiesFromGarmin() already settled the synced suggestion against the new
      // rides. If one just completed, regenerate so the AI scores it and hands out the
      // next session immediately instead of at the next 23h refresh.
      const current = getCurrentFreeSuggestion();
      const justCompleted = !current || current.id !== preSyncFreeId;
      if (preSyncFreeId !== null && justCompleted && instantScoringEnabled) {
        logger.info(`[Free] Suggestion #${preSyncFreeId} completed during sync — triggering AI re-evaluation`);
        generateFreeSuggestion().catch((err: any) =>
          logger.warn(`[Free] Auto-regen after activity sync failed: ${err.message}`)
        );
        planRegenTriggered = true;
      } else if (preSyncFreeId !== null && justCompleted) {
        logger.info(`[Free] Suggestion #${preSyncFreeId} completed but instant scoring is disabled — skipping immediate regen`);
      }
    } else if (stored?.weeklyPlan && prePlannedDates.size > 0) {
      const newlyCompleted = stored.weeklyPlan.filter(
        (e: any) => e.status === 'completed' && prePlannedDates.has(e.date)
      );
      if (newlyCompleted.length > 0 && instantScoringEnabled) {
        logger.info(`[Gemini] ${newlyCompleted.length} newly completed workout(s) (${newlyCompleted.map((e: any) => e.date).join(', ')}) — triggering AI re-evaluation`);
        generateRecommendation(stored.weeklyPlan).catch((err: any) =>
          logger.warn(`[Gemini] Auto-regen after activity sync failed: ${err.message}`)
        );
        planRegenTriggered = true;
      } else if (newlyCompleted.length > 0) {
        logger.info(`[Gemini] ${newlyCompleted.length} newly completed workout(s) detected but instant scoring is disabled — skipping immediate regen`);
      } else {
        logger.info('[Gemini] Activity sync: no newly completed workouts detected in current plan');
      }
    }

    const profile = await getActiveProfile();
    res.json({
      activities:        getStoredActivities(),
      analysis:          getStoredAnalysis(),
      currentProfile:    profile,
      newCount,
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

/**
 * Re-evaluate the plan (or free suggestion) because the athlete told us something new
 * about their own state — a ride rating, or a daily check-in.
 *
 * Non-blocking: the caller has already committed what the athlete said, and the UI polls
 * for the result. Reacting to this is the point of the app, so the only reasons not to are
 * no API key, paused training, or the athlete opting out to save calls.
 *
 * In free mode this can displace a suggestion the athlete has already pushed to their
 * watch. The hourly auto-check refuses to do that on staleness alone, but reacting to how
 * someone actually feels is the point of the app, so here it goes ahead — and reports what
 * it displaced, because the Garmin workout stays on their calendar and only they can
 * remove it. Silently orphaning it would be the worst of both.
 */
interface AdaptiveRegenResult {
  regenerating: boolean;
  /** Set only when a synced free-mode workout was replaced — the athlete must be told. */
  replacedSyncedWorkout: { type: string; date: string } | null;
}

const triggerAdaptiveRegen = (context: string): AdaptiveRegenResult => {
  const none: AdaptiveRegenResult = { regenerating: false, replacedSyncedWorkout: null };

  if (!getGeminiKey()) return none;
  if (getSetting('training_paused') === '1') return none;
  if (getSetting('instant_score_on_new_activity') === '0') {
    logger.info(`[${context}] Instant re-evaluation is disabled — leaving it to the next cycle`);
    return none;
  }

  const freeMode = isFreeTrainingMode();
  let replacedSyncedWorkout: AdaptiveRegenResult['replacedSyncedWorkout'] = null;

  if (freeMode) {
    const current = getCurrentFreeSuggestion();
    if (current?.status === 'synced' && current.syncedForDate) {
      replacedSyncedWorkout = { type: current.workoutType, date: current.syncedForDate };
      logger.warn(`[${context}] Replacing suggestion #${current.id} (${current.workoutType}) that was synced for ${current.syncedForDate} — the Garmin workout is left behind for the athlete to remove`);
    }
  }

  const regen = freeMode
    ? generateFreeSuggestion()
    : generateRecommendation(getStoredRecommendation()?.weeklyPlan);
  regen
    .then(() => setSetting('gemini_last_generated', new Date().toISOString()))
    .catch((err: any) => logger.warn(`[${context}] Regen failed: ${err.message}`));

  return { regenerating: true, replacedSyncedWorkout };
};

// ── Daily check-in ────────────────────────────────────────────────────────────
//
// The only way the athlete can say how they feel without riding. Every other signal in
// Velomate hangs off an activity, which leaves rest days — and the bad night before one —
// silent. One standing answer per day; re-submitting corrects it.

app.get('/api/checkin', (_req: Request, res: Response) => {
  res.json({
    today:   getCheckin(localDate()),
    history: getRecentCheckins(10)
  });
});

app.post('/api/checkin', (req: Request, res: Response) => {
  const { feeling, note } = req.body ?? {};

  if (!Number.isInteger(feeling) || feeling < 1 || feeling > 5) {
    return res.status(400).json({ error: 'feeling must be an integer from 1 to 5.' });
  }
  if (note != null && typeof note !== 'string') {
    return res.status(400).json({ error: 'note must be a string.' });
  }

  const today   = localDate();
  const trimmed = note ? note.trim().slice(0, 200) : null;

  // Re-planning is only justified when the athlete is telling us something new. If they
  // submit the same answer again — correcting a typo, or just pressing Save twice — the
  // plan was already built on exactly this input, so regenerating would spend an API call
  // to arrive at the same place.
  const existing  = getCheckin(today);
  const unchanged = existing !== null
    && existing.feeling === feeling
    && (existing.note ?? null) === (trimmed || null);

  upsertCheckin(today, feeling, trimmed || null);
  logger.info(`[Check-in] ${today}: ${feeling}/5${trimmed ? ` — "${trimmed}"` : ''}${unchanged ? ' (unchanged)' : ''}`);

  if (unchanged) logger.info('[Check-in] Same answer as before — no re-evaluation needed');
  const regen = unchanged
    ? { regenerating: false, replacedSyncedWorkout: null }
    : triggerAdaptiveRegen('Check-in');

  res.json({ saved: true, today: getCheckin(today), history: getRecentCheckins(10), ...regen });
});

/**
 * Clear today's rating, so the plan can be generated as if the athlete never answered.
 *
 * Not the same as rating yourself Normal — that is still an answer, and the prompt weighs it.
 * Removing the line is itself new information (the plan was built on it), so this re-plans too,
 * but only when there was actually something to remove.
 */
app.delete('/api/checkin', (_req: Request, res: Response) => {
  const today   = localDate();
  const removed = deleteCheckin(today);

  if (removed) logger.info(`[Check-in] ${today} cleared — regenerating without it`);
  else         logger.info(`[Check-in] ${today} cleared, but there was nothing to clear`);

  const regen = removed
    ? triggerAdaptiveRegen('Check-in cleared')
    : { regenerating: false, replacedSyncedWorkout: null };

  res.json({ cleared: removed, today: null, history: getRecentCheckins(10), ...regen });
});

// ── Activity feedback (RPE / feeling) ─────────────────────────────────────────
//
// How the athlete's own read on a ride gets in. Until now it could only be entered on
// the watch, which made the single most important signal in the app — how the ride
// actually felt, including the toll of whatever non-cycling training preceded it —
// dependent on remembering to answer a prompt on another device.
//
// Garmin is written FIRST and the local row only follows on success, so the two can
// never silently disagree. A failed write leaves everything exactly as it was.

app.post('/api/activities/:activityId/feedback', async (req: Request, res: Response) => {
  const { activityId } = req.params;
  const { rpe, feeling } = req.body ?? {};

  const validScale = (v: any, min: number, max: number) =>
    v === null || v === undefined || (Number.isInteger(v) && v >= min && v <= max);

  if (!validScale(rpe, 1, 10)) {
    return res.status(400).json({ error: 'rpe must be an integer from 1 to 10, or null.' });
  }
  if (!validScale(feeling, 1, 5)) {
    return res.status(400).json({ error: 'feeling must be an integer from 1 to 5, or null.' });
  }
  if (rpe == null && feeling == null) {
    return res.status(400).json({ error: 'Provide rpe, feeling, or both.' });
  }

  const activity = getStoredActivities().find((a: any) => String(a.activityId) === String(activityId));
  if (!activity) return res.status(404).json({ error: 'Unknown activity.' });

  // Keep whichever value the athlete did not touch — a partial update must not blank the other.
  const rawRpe  = rpe     != null ? fromRpe(rpe)         : activity.perceivedExertion ?? null;
  const rawFeel = feeling != null ? fromFeeling(feeling) : activity.feelingAfterExercise ?? null;

  try {
    await pushActivityFeedback(String(activityId), rawRpe, rawFeel);
  } catch (error: any) {
    logger.warn(`[Feedback] Garmin rejected feedback for ${activityId}: ${error.message}`);
    return res.status(error.message.includes('authenticated') ? 401 : 502).json({
      error: 'Could not save this to Garmin, so it was not saved here either.',
      details: error.message
    });
  }

  updateActivityFeedback(String(activityId), rawRpe, rawFeel);
  logger.info(`[Feedback] Activity ${activityId}: rpe=${rpe ?? "-"}/10, feeling=${feeling ?? "-"}/5 (raw ${rawRpe ?? "-"}, ${rawFeel ?? "-"})`);

  // How a ride felt is exactly the kind of signal the plan is supposed to react to.
  const regen = triggerAdaptiveRegen('Feedback');

  res.json({ success: true, activities: getStoredActivities(), ...regen });
});

// ── Sync Workouts ─────────────────────────────────────────────────────────────

app.post('/api/sync-workouts', async (req: Request, res: Response) => {
  const { scheduleDate } = req.body;
  try {
    if (!requireMode(res, false)) return;
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
  const geminiModel   = getGeminiModel();

  // Preferred long ride days — read from plural key, fall back to legacy singular key
  const rawDays = getSetting('preferred_long_ride_days') || getSetting('preferred_long_ride_day') || '';
  const preferredLongRideDays = rawDays
    ? rawDays.split(',').map((d: string) => d.trim()).filter(Boolean)
    : [];

  const inactivityPauseDays = parseInt(getSetting('inactivity_pause_days') || '14', 10) || 14;
  const instantScoreOnNewActivity = getSetting('instant_score_on_new_activity') !== '0';

  res.json({
    hasKey:               !!key,
    maskedKey:            key ? maskKey(key) : null,
    setupComplete,
    preferredLongRideDays,
    geminiModel,
    inactivityPauseDays,
    instantScoreOnNewActivity,
    freeTrainingMode:     isFreeTrainingMode()
  });
});

// Free training mode — replaces the 14-day plan with a single dateless suggestion.
// The weekly plan is left untouched in the DB so switching back restores it.
app.post('/api/settings/free-training-mode', (req: Request, res: Response) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean.' });
  }
  setSetting('free_training_mode', enabled ? '1' : '0');
  // Whichever mode we land in, its current output is now the stale one — clear the
  // freshness stamp so the next auto-check regenerates instead of waiting out 23h.
  setSetting('gemini_last_generated', '0');
  logger.info(`[Settings] Free training mode: ${enabled ? 'enabled' : 'disabled'}`);
  res.json({ saved: true });
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

app.post('/api/settings/instant-score-on-new-activity', (req: Request, res: Response) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean.' });
  }
  setSetting('instant_score_on_new_activity', enabled ? '1' : '0');
  logger.info(`[Settings] Instant score-on-new-activity: ${enabled ? 'enabled' : 'disabled'}`);
  res.json({ saved: true });
});

app.post('/api/settings/gemini-model', (req: Request, res: Response) => {
  const { model } = req.body;
  if (!model || typeof model !== 'string' || !model.trim()) {
    return res.status(400).json({ error: 'model is required.' });
  }
  // The settings form accepts a free-text model ID so a model released after this build —
  // or a paid-tier one — can be used without shipping an update. That makes validation here
  // mandatory rather than cosmetic: the value is interpolated into the Gemini request path,
  // so a stray '/', '?' or '..' would rewrite the endpoint instead of naming a model.
  const normalized = normalizeModelId(model);
  if (!isValidModelId(normalized)) {
    return res.status(400).json({
      error: 'Invalid model ID. Use the ID exactly as Google lists it, for example "gemini-3.6-flash".'
    });
  }
  setSetting('gemini_model', normalized);
  logger.info(`[Settings] Gemini model set to: ${normalized}`);
  res.json({ saved: true, model: normalized });
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

  // Non-blocking: sync fresh activities, then regenerate with pause context — a plan, or in
  // free mode a single suggestion calibrated to the time off. The athlete sees the
  // pre-pause plan/suggestion immediately (via fetchCached) and the frontend polls for the
  // fresh one, rather than waiting on the Gemini round trip here.
  const key = getGeminiKey();
  if (key) {
    (async () => {
      try {
        await syncActivitiesFromGarmin();
        const pauseCtx = pausedSince
          ? { pausedSince: pausedSince.slice(0, 10), pauseReason: pauseReason || undefined, activitiesCount }
          : undefined;
        if (isFreeTrainingMode()) {
          await generateFreeSuggestion(pauseCtx);
        } else {
          const current = getStoredRecommendation();
          await generateRecommendation(current?.weeklyPlan, pauseCtx);
        }
        setSetting('gemini_last_generated', new Date().toISOString());
      } catch (err: any) {
        logger.warn(`[Training] Resume: plan regen failed: ${err.message}`);
      }
    })();
  }

  res.json({ resumed: true, regenerating: !!key });
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

  // Truthful answer to "is a new plan on its way?" — previously the frontend could only
  // guess by polling for a changed generatedAt on every dashboard mount.
  res.json({ ...rec, stale, regenerating: isGenerationInFlight() });
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
    if (!requireMode(res, false)) return;
    if (getSetting('training_paused') === '1') {
      return res.status(403).json({ error: 'Training is paused. Resume training before refreshing the plan.' });
    }
    // Always sync activities first so the AI works with current ride data
    await syncActivitiesFromGarmin();

    const current = getStoredRecommendation();
    if (current) {
      const planSummary = current.weeklyPlan.map((e: any) => `${e.date}:${e.type}[${e.status}]`).join(' ');
      logger.info(`[Gemini] Manual refresh requested — current plan: ${planSummary}`);
      // Non-blocking: there's already a plan to show, so don't make the athlete wait on the
      // Gemini round trip — return the current plan immediately and let the AI's refreshed
      // read arrive in the background (frontend polls, same pattern as the sync auto-regen).
      generateRecommendation(current.weeklyPlan)
        .then(() => setSetting('gemini_last_generated', new Date().toISOString()))
        .catch((err: any) => logger.warn(`[Gemini] Manual refresh regen failed: ${err.message}`));
      res.json({ ...current, regenerating: true });
      return;
    }

    // First-ever plan: nothing to show yet, so this one has to block.
    logger.info('[Gemini] Manual refresh requested — no existing plan');
    const result = await generateRecommendation(current?.weeklyPlan);
    setSetting('gemini_last_generated', new Date().toISOString());
    res.json(result);
  } catch (error: any) {
    handleGeminiError(res, error, 'Refresh error');
  }
});

app.post('/api/recommendation/skip-today', async (req: Request, res: Response) => {
  try {
    if (!requireMode(res, false)) return;
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

    // Non-blocking: the skip is already committed — return it right away and let the AI's
    // re-plan of the rest of the week arrive in the background.
    generateRecommendation(updated?.weeklyPlan)
      .then(() => setSetting('gemini_last_generated', new Date().toISOString()))
      .catch((err: any) => logger.warn(`[Plan] Skip-today regen failed (skip already committed): ${err.message}`));
    res.json({ ...updated, regenerating: true });
  } catch (error: any) {
    handleGeminiError(res, error, 'Skip-today error');
  }
});

app.post('/api/recommendation/reschedule', async (req: Request, res: Response) => {
  try {
    if (!requireMode(res, false)) return;
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

    // Non-blocking: the swap is already committed — return it immediately, so the UI
    // reflects the move without waiting on the Gemini round trip. AI re-evaluation of the
    // week arrives in the background.
    generateRecommendation(updated?.weeklyPlan, undefined, pinnedTodayType)
      .then(() => setSetting('gemini_last_generated', new Date().toISOString()))
      .catch((err: any) => logger.warn(`[Plan] Reschedule regen failed (swap already committed): ${err.message}`));
    res.json({ ...updated, regenerating: true });
  } catch (error: any) {
    handleGeminiError(res, error, 'Reschedule error');
  }
});

// ── Free training ─────────────────────────────────────────────────────────────
// The free-mode counterpart of /api/recommendation*: one dateless suggestion instead of
// a 14-day plan. Same state shapes (notConfigured / paused / stale) so the frontend can
// reuse the recommendation card's states, and the same "first one needs a user action"
// invariant — the auto-check never creates the very first suggestion.

/** How long a suggestion stays fresh before the UI marks it stale — matches the plan. */
const FREE_STALE_MS = 23 * 60 * 60 * 1000;

const freeTrainingPayload = () => {
  const suggestion = getCurrentFreeSuggestion();
  if (!suggestion) return { noSuggestion: true };
  const ageMs = Date.now() - new Date(suggestion.generatedAt).getTime();
  return {
    suggestion,
    history:      getFreeSuggestionHistory(10),
    stale:        ageMs > FREE_STALE_MS,
    regenerating: isGenerationInFlight()
  };
};

app.get('/api/free-training', (_req: Request, res: Response) => {
  if (!getGeminiKey()) return res.json({ notConfigured: true });
  if (!requireMode(res, true)) return;

  if (getSetting('training_paused') === '1') {
    return res.json({
      paused:      true,
      pausedSince: getSetting('paused_since') || '',
      pauseReason: getSetting('pause_reason') || ''
    });
  }

  res.json(freeTrainingPayload());
});

/** Force a new suggestion. Also used for "generate my first suggestion". */
app.post('/api/free-training/refresh', async (_req: Request, res: Response) => {
  try {
    if (!requireMode(res, true)) return;
    if (getSetting('training_paused') === '1') {
      return res.status(403).json({ error: 'Training is paused. Resume training before asking for a new suggestion.' });
    }
    // Always sync first so the AI judges recovery on current ride data — and so a synced
    // suggestion the athlete has since ridden is settled (and therefore scorable) first.
    await syncActivitiesFromGarmin();

    const current = getCurrentFreeSuggestion();
    logger.info(`[Free] Refresh requested — current: ${current ? `#${current.id} ${current.workoutType} [${current.status}]` : 'none'}`);

    if (current) {
      // Non-blocking: there's already a suggestion to show — return it immediately
      // (marked regenerating) and let the frontend poll for the replacement.
      generateFreeSuggestion(undefined, true)
        .then(() => setSetting('gemini_last_generated', new Date().toISOString()))
        .catch((err: any) => logger.warn(`[Free] Refresh regen failed: ${err.message}`));
      res.json({ ...freeTrainingPayload(), regenerating: true });
      return;
    }

    // First-ever suggestion: nothing to show yet, so this one has to block.
    await generateFreeSuggestion(undefined, true);
    setSetting('gemini_last_generated', new Date().toISOString());
    res.json(freeTrainingPayload());
  } catch (error: any) {
    handleGeminiError(res, error, 'Free training refresh error');
  }
});

/**
 * "Not this one" — explicitly reject the current suggestion and ask for another.
 * Recorded as 'dismissed' rather than the plain 'superseded' a refresh produces, so the
 * AI can tell a rejected suggestion apart from one that was simply replaced by a newer read
 * of the same data, and stop offering workouts this athlete keeps turning down.
 */
app.post('/api/free-training/dismiss', async (_req: Request, res: Response) => {
  try {
    if (!requireMode(res, true)) return;
    if (getSetting('training_paused') === '1') {
      return res.status(403).json({ error: 'Training is paused. Resume training before making changes.' });
    }
    if (!getCurrentFreeSuggestion()) {
      return res.status(404).json({ error: 'No current suggestion to dismiss.' });
    }

    await syncActivitiesFromGarmin();

    // Re-read after the sync: it may have matched a ride to this suggestion and marked it
    // completed. A completed suggestion must not be overwritten as dismissed — the athlete
    // actually did it, and that ride still needs to be scored.
    const current = getCurrentFreeSuggestion();
    if (current) {
      markFreeSuggestionDismissed(current.id);
      logger.info(`[Free] Suggestion #${current.id} (${current.workoutType}) dismissed by athlete — generating a replacement`);

      // Non-blocking: return the just-dismissed suggestion immediately so there's still
      // something on screen while the AI picks a replacement in the background. Built from
      // `current` (already in hand) rather than re-querying — the instant it's marked
      // dismissed, getCurrentFreeSuggestion()/freeTrainingPayload() would report none at all.
      generateFreeSuggestion()
        .then(() => setSetting('gemini_last_generated', new Date().toISOString()))
        .catch((err: any) => logger.warn(`[Free] Dismiss regen failed (dismissal already committed): ${err.message}`));
      res.json({ suggestion: current, history: getFreeSuggestionHistory(10), stale: true, regenerating: true });
      return;
    }

    // Rare edge case: the sync matched a ride to this suggestion before the athlete's
    // dismiss landed, so there's nothing sensible to show as "current" — this one blocks.
    logger.info('[Free] Dismiss: suggestion was completed by a ride during the sync — generating the next one instead');
    await generateFreeSuggestion();
    setSetting('gemini_last_generated', new Date().toISOString());
    res.json(freeTrainingPayload());
  } catch (error: any) {
    handleGeminiError(res, error, 'Free training dismiss error');
  }
});

/**
 * Upload + schedule the current suggestion on Garmin.
 * The date the button is pressed becomes the workout's date — in the name and on the
 * calendar — which is the only date a free suggestion ever gets, and what makes it
 * traceable afterwards.
 */
app.post('/api/free-training/sync', async (_req: Request, res: Response) => {
  try {
    if (!requireMode(res, true)) return;

    const current = getCurrentFreeSuggestion();
    if (!current) return res.status(404).json({ error: 'No current suggestion to sync.' });
    if (current.workoutType === 'Rest') {
      return res.status(400).json({ error: 'This suggestion is a rest day — there is no workout to sync.' });
    }

    const pressedOn = localDate();
    const result    = await syncFreeWorkout(current.workoutType, current.structure, pressedOn);
    markFreeSuggestionSynced(current.id, pressedOn);
    logger.info(`[Free] Suggestion #${current.id} (${current.workoutType}) synced to Garmin for ${pressedOn}`);

    res.json({ success: true, ...result, ...freeTrainingPayload() });
  } catch (error: any) {
    res.status(error.message.includes('authenticated') ? 401 : 500).json({
      error: 'Failed to create or schedule the workout.',
      details: error.message
    });
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

// ── Debug — raw Garmin HR/zone data (discover real LTHR / zone boundaries) ────
// Hit GET /api/debug/garmin-hr-data to inspect userData + an activity detail for
// any field that could give us the athlete's REAL LTHR or zone boundaries,
// instead of Velomate's own guessed ×0.88 estimate.
app.get('/api/debug/garmin-hr-data', async (_req: Request, res: Response) => {
  try {
    const isAuthenticated = await trySessionAuth();
    if (!isAuthenticated) return res.status(401).json({ error: 'Not authenticated.' });

    const client = getGarminClient();
    const token  = (client.client as any).oauth2Token?.access_token;
    if (!token) return res.status(401).json({ error: 'No active Garmin session token.' });

    // ── 1. User settings — may contain lactateThresholdHeartRate / maxHrBpm ──
    let userData: Record<string, any> = {};
    let userSettingsError: string | null = null;
    try {
      const settingsRes = await axios.get('https://connectapi.garmin.com/userprofile-service/userprofile/user-settings/', {
        headers: { Authorization: `Bearer ${token}` }
      });
      userData = settingsRes.data?.userData ?? {};
    } catch (e: any) {
      userSettingsError = e.message;
    }

    // ── 2. Activity detail — may contain a zones/boundary array ──────────────
    const acts = await client.getActivities(0, 10);
    const cycling = acts.filter((a: any) => {
      const t = (a.activityType?.typeKey || '').toLowerCase();
      return t.includes('cycl') || t.includes('bik');
    });
    const first = cycling[0] ?? acts[0];

    let activityDetail: any = null;
    let activityDetailError: string | null = null;
    if (first) {
      try {
        activityDetail = await client.getActivity({ activityId: (first as any).activityId });
      } catch (e: any) {
        activityDetailError = e.message;
      }
    }

    // Scan both payloads for any key that looks zone/boundary/threshold related.
    const scanForZoneKeys = (obj: any, path = ''): Record<string, any> => {
      const hits: Record<string, any> = {};
      if (!obj || typeof obj !== 'object') return hits;
      for (const [k, v] of Object.entries(obj)) {
        const fullPath = path ? `${path}.${k}` : k;
        if (/zone|boundary|threshold|lthr|lactate/i.test(k)) {
          hits[fullPath] = v;
        }
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          Object.assign(hits, scanForZoneKeys(v, fullPath));
        } else if (Array.isArray(v)) {
          v.forEach((item, i) => Object.assign(hits, scanForZoneKeys(item, `${fullPath}[${i}]`)));
        }
      }
      return hits;
    };

    res.json({
      userSettingsError,
      activityDetailError,
      activityId:            first ? (first as any).activityId : null,
      userDataFull:           userData,
      zoneRelatedInUserData:  scanForZoneKeys(userData),
      zoneRelatedInActivity:  scanForZoneKeys(activityDetail),
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

  if (isFreeTrainingMode()) {
    const s = getCurrentFreeSuggestion();
    logger.info(`[Free] Auto-check state: ${s ? `#${s.id} ${s.workoutType} [${s.status}]${s.syncedForDate ? ` synced for ${s.syncedForDate}` : ''}` : 'no suggestion in DB'}, age ${ageHours}h`);
    return;
  }

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

/**
 * Auto-pause after N consecutive days without any completed workout (default 14,
 * user-configurable). Reference date: last completed workout, or if never, the plan
 * creation date. This naturally handles "plan not yet started" — a brand-new plan won't
 * reach N days yet. Shared by both modes; in free mode the reference date is stamped from
 * the athlete's most recent ride instead of a completed plan entry.
 * Returns true when it paused, meaning the caller should stop.
 */
const maybeAutoPause = (): boolean => {
  const inactivityThreshold = parseInt(getSetting('inactivity_pause_days') || '14', 10) || 14;
  const lastActivity = getSetting('last_plan_activity_date');
  const refDate      = lastActivity ?? getSetting('gemini_last_generated');
  if (!refDate || refDate === '0') return false;

  const daysSince = Math.floor((Date.now() - new Date(refDate).getTime()) / 86_400_000);
  if (daysSince < inactivityThreshold) return false;

  setSetting('training_paused', '1');
  setSetting('paused_since', new Date().toISOString());
  setSetting('pause_reason', `Automatically paused after ${inactivityThreshold} days without any training activity.`);
  logger.info(`[Gemini] Auto-check: auto-pausing — ${daysSince} days without activity (threshold: ${inactivityThreshold}, ref: ${refDate})`);
  return true;
};

/**
 * Free-mode auto-check. Mirrors the plan flow minus everything date-bound: there are no
 * days to auto-skip, only a synced suggestion that may since have been ridden. Like the
 * plan, it never creates the FIRST suggestion — that stays a deliberate user action.
 */
const runFreeAutoCheck = async () => {
  const preSyncId = getCurrentFreeSuggestion()?.id ?? null;

  logger.info('[Free] Auto-check: syncing activities from Garmin before evaluation…');
  await syncActivitiesFromGarmin();   // settles a synced suggestion against new rides

  const current = getCurrentFreeSuggestion();
  const justCompleted = preSyncId !== null && (!current || current.id !== preSyncId);
  const instantScoringEnabled = getSetting('instant_score_on_new_activity') !== '0';

  if (justCompleted && instantScoringEnabled) {
    logger.info(`[Free] Auto-check: suggestion #${preSyncId} was ridden — generating the next one and scoring it`);
    await generateFreeSuggestion();
    setSetting('gemini_last_generated', new Date().toISOString());
    return;
  }

  if (maybeAutoPause()) return;

  if (!current && !justCompleted) {
    logger.info('[Free] Auto-check: no suggestion yet — waiting for the athlete to ask for their first one');
    return;
  }

  // A synced suggestion is already sitting on the athlete's watch, waiting to be ridden —
  // and in free mode "whenever suits you" may well be several days out. Replacing it on
  // staleness alone would mark it not-ridden and orphan the Garmin workout, so leave it
  // alone until a ride matches it or the athlete asks for something else themselves.
  // The inactivity auto-pause above is what stops this from waiting forever.
  if (current?.status === 'synced') {
    logger.info(`[Free] Auto-check: suggestion #${current.id} is synced for ${current.syncedForDate} and not yet ridden — leaving it in place`);
    return;
  }

  const lastGenStr = getSetting('gemini_last_generated');
  const ageMs      = Date.now() - (lastGenStr && lastGenStr !== '0' ? new Date(lastGenStr).getTime() : 0);
  if (ageMs > 23 * 60 * 60 * 1000) {
    logger.info(`[Free] Auto-check: regenerating — suggestion is ${(ageMs / 3600000).toFixed(1)}h old (> 23h)`);
    await generateFreeSuggestion();
    setSetting('gemini_last_generated', new Date().toISOString());
  } else {
    logger.info(`[Free] Auto-check: suggestion is fresh (${(ageMs / 3600000).toFixed(1)}h old) — no regen needed`);
  }
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

    // Free mode has no weekly plan to keep current — a completely different check.
    if (isFreeTrainingMode()) {
      await runFreeAutoCheck();
      return;
    }

    // Capture which dates were 'planned' BEFORE syncing, same as /api/activities/refresh,
    // so a newly-completed ride can be detected after the sync below.
    const preSyncPlan    = getStoredRecommendation()?.weeklyPlan || [];
    const prePlannedDates = new Set(
      preSyncPlan.filter((e: any) => e.status === 'planned').map((e: any) => e.date)
    );

    // Sync activities first — auto-skip detection depends on having current ride data
    logger.info('[Gemini] Auto-check: syncing activities from Garmin before evaluation…');
    await syncActivitiesFromGarmin();

    // Detect auto-skips (planned days that passed with no activity) and newly-completed rides
    const stored = getStoredRecommendation();
    if (stored?.weeklyPlan) {
      // Don't auto-skip dates that fall within a completed pause period
      const pausedSince = getSetting('paused_since') || '';
      const autoSkips = detectAutoSkippedEntries(stored.weeklyPlan)
        .filter(date => !pausedSince || date < pausedSince.slice(0, 10));

      const instantScoringEnabled = getSetting('instant_score_on_new_activity') !== '0';
      const newlyCompleted = prePlannedDates.size > 0
        ? stored.weeklyPlan.filter((e: any) => e.status === 'completed' && prePlannedDates.has(e.date))
        : [];
      const shouldRegenForNewActivity = instantScoringEnabled && newlyCompleted.length > 0;

      if (autoSkips.length > 0) {
        logger.info(`[Gemini] Auto-check: ${autoSkips.length} auto-skip(s) detected (${autoSkips.join(', ')}) — marking and regenerating`);
        autoSkips.forEach(date => updatePlanEntryStatus(date, 'auto-skipped'));
      }
      if (shouldRegenForNewActivity) {
        logger.info(`[Gemini] Auto-check: ${newlyCompleted.length} newly completed workout(s) (${newlyCompleted.map((e: any) => e.date).join(', ')}) — triggering instant AI re-evaluation`);
      }
      if (autoSkips.length > 0 || shouldRegenForNewActivity) {
        const updated = getStoredRecommendation();
        await generateRecommendation(updated?.weeklyPlan);
        setSetting('gemini_last_generated', new Date().toISOString());
        return; // already regenerated
      }
    }

    if (maybeAutoPause()) return;

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

app.listen(PORT, BIND_HOST, () => {
  const profile   = getStoredProfile();
  const acts      = getStoredActivities();
  const rec       = getStoredRecommendation();
  const geminiKey = getGeminiKey();
  const setup     = getSetting('setup_complete') === '1';
  const lastGen   = getSetting('gemini_last_generated');

  logger.info('='.repeat(60));
  logger.info(`${APP_NAME} backend started — listening on ${BIND_HOST}:${PORT}`);
  logger.info(`Profile: maxHR ${profile?.maxHr ?? '?'} bpm, LTHR ${profile?.lthr ?? '?'} bpm | Activities: ${acts.length} stored | Setup: ${setup ? 'yes' : 'no'}`);
  const freeMode  = isFreeTrainingMode();
  const freeSugg  = freeMode ? getCurrentFreeSuggestion() : null;
  const output    = freeMode
    ? `Free suggestion: ${freeSugg ? `${freeSugg.workoutType} [${freeSugg.status}]` : 'none'}`
    : `Plan: ${rec ? `${rec.workoutType} (${rec.loadAssessment?.fatigue} fatigue)` : 'none'}`;
  logger.info(`Gemini key: ${geminiKey ? maskKey(geminiKey) : 'not configured'} | Mode: ${freeMode ? 'free training' : 'weekly plan'} | Last generated: ${lastGen && lastGen !== '0' ? lastGen : 'never'} | ${output}`);
  logger.info('='.repeat(60));
});
