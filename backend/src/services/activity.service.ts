import { getGarminClient, trySessionAuth } from './garmin.service';
import { calculateDefaultZones, loadProfile } from './profile.service';
import { updateActivityFeedback } from './database.service';
import { toRpe, toFeeling } from '../utils';
import logger from '../logger';

export const fetchCyclingActivities = async (days: number = 90) => {
  const isAuthenticated = await trySessionAuth();
  if (!isAuthenticated) {
    throw new Error('Not authenticated with Garmin Connect.');
  }

  const client = getGarminClient();
  // Fetch enough activities to cover the requested period even if the user
  // does many other activity types. 300 covers most scenarios.
  const activities = await client.getActivities(0, 300);

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  // Log all activity types so we can see what Garmin returns
  const sample = activities.map(a => ({
    name: a.activityName,
    typeKey: a.activityType?.typeKey,
    date: a.startTimeLocal
  }));
  logger.info('[Activities] All activities from Garmin: ' + JSON.stringify(sample, null, 2));

  const cyclingActivities = activities.filter(act => {
    const typeKey = (act.activityType?.typeKey || '').toLowerCase();
    const isCycling = typeKey.includes('cycl') || typeKey.includes('bik');
    const isRecent = act.startTimeLocal
      ? new Date(act.startTimeLocal) >= cutoff
      : true;
    return isCycling && isRecent;
  });

  let zonesFoundCount = 0;
  let rpeFoundCount   = 0;

  // Log all field names present on the first activity — helps discover new API fields.
  if (cyclingActivities.length > 0) {
    const sample = cyclingActivities[0] as any;
    const nonNullFields = Object.keys(sample).filter(k => sample[k] != null && sample[k] !== 0 && sample[k] !== '');
    logger.info(`[Activities] Fields with data on first activity: ${nonNullFields.join(', ')}`);
  }

  const mapped = cyclingActivities.map(act => {
    // Extract Garmin's 5-zone time distribution (seconds per zone, index 0=z1 … 4=z5).
    // Garmin may return this as hrTimeInHrZone or timeInHrZone depending on the API version.
    const rawZones =
      (act as any).hrTimeInHrZone ||
      (act as any).timeInHrZone   ||
      ((act as any).hrTimeInZone_1 != null
        ? [
            (act as any).hrTimeInZone_1 ?? 0,
            (act as any).hrTimeInZone_2 ?? 0,
            (act as any).hrTimeInZone_3 ?? 0,
            (act as any).hrTimeInZone_4 ?? 0,
            (act as any).hrTimeInZone_5 ?? 0,
          ]
        : null);

    const timeInZones: number[] | null =
      Array.isArray(rawZones) && rawZones.length >= 5
        ? (rawZones as number[]).slice(0, 5).map(Number)
        : null;

    if (timeInZones) zonesFoundCount++;

    // Perceived exertion: Edge post-activity "Rate your effort" prompt (scale 1-10).
    // Field name observed in Garmin Connect API response.
    const perceivedExertion: number | null =
      (act as any).perceivedExertion ?? null;

    // Post-ride feeling: Edge "How do you feel?" prompt (1=Very Tired … 5=Very Good).
    // Garmin may expose this under different field names depending on firmware/API version.
    const feelingAfterExercise: number | null =
      (act as any).feelingAfterExercise ??
      (act as any).activityFeedback     ??
      (act as any).userTrainingFeedback ??
      null;

    if (perceivedExertion != null) rpeFoundCount++;

    return {
      activityId:          act.activityId,
      name:                act.activityName,
      type:                act.activityType?.typeKey,
      startTime:           act.startTimeLocal,
      distanceKm:          act.distance ? Math.round((act.distance / 1000) * 10) / 10 : 0,
      durationMinutes:     act.duration ? Math.round(act.duration / 60) : 0,
      averageHr:           act.averageHR || 0,
      maxHr:               act.maxHR || 0,
      averagePower:        (act.avgPower as number) || 0,
      maxPower:            (act.maxPower as number) || 0,
      timeInZones,          // null when Garmin doesn't include zone data in the summary
      perceivedExertion,    // null when athlete hasn't rated effort on device
      feelingAfterExercise, // null when athlete hasn't answered "how do you feel"
    };
  });

  logger.info(`[Activities] Zone data found for ${zonesFoundCount}/${mapped.length} cycling activities`);
  logger.info(`[Activities] RPE data found for ${rpeFoundCount}/${mapped.length} cycling activities`);
  return mapped;
};

/**
 * @param realLthr Garmin's own lactateThresholdHeartRate (userprofile-service), when available —
 *   preferred over the ×0.88 guess. Sanity-checked (must be a plausible bpm value below maxHR)
 *   since it comes from an `unknown`-typed field in the Garmin client library.
 */
export const assessProgression = (activities: any[], realLthr?: number | null) => {
  let maxRecordedHr = 0;
  let durationSumSeconds = 0;

  activities.forEach(act => {
    if (act.maxHr > maxRecordedHr) {
      maxRecordedHr = act.maxHr;
    }
    if (act.durationMinutes > 0) {
      durationSumSeconds += act.durationMinutes * 60;
    }
  });

  const averageRideDuration = activities.length > 0
    ? Math.round(durationSumSeconds / activities.length)
    : 120 * 60;

  let estimatedMaxHr = maxRecordedHr > 0 ? maxRecordedHr : 190;
  const hasSaneRealLthr = typeof realLthr === 'number' && realLthr > 100 && realLthr < estimatedMaxHr;
  let estimatedLthr = hasSaneRealLthr ? (realLthr as number) : Math.round(estimatedMaxHr * 0.88);

  return {
    totalCyclingRides: activities.length,
    maxRecordedHr,
    estimatedMaxHr,
    estimatedLthr,
    averageRideDurationMinutes: Math.round(averageRideDuration / 60),
    suggestedZones: calculateDefaultZones(estimatedLthr, estimatedMaxHr)
  };
};

/**
 * Fetch per-activity detail for the most recent activities that don't yet have
 * feedback data (perceivedExertion == null) and store the converted values.
 *
 * Garmin API fields from summaryDTO:
 *   directWorkoutRpe  0–100  → divide by 10 → 1–10 Borg RPE scale
 *   directWorkoutFeel 0–100  → divide by 25, add 1 → 1–5 feeling scale
 *                              (0=level 1 Exhausted … 100=level 5 Strong)
 *
 * Called (awaited) as part of syncActivitiesFromGarmin() so the AI always has
 * complete feedback data before generateRecommendation() runs.
 * Capped at FEEDBACK_FETCH_LIMIT to stay within Garmin rate limits.
 */
const FEEDBACK_FETCH_LIMIT = 5;

export const fetchAndStoreRecentFeedback = async (storedActivities: any[]): Promise<void> => {
  const missing = storedActivities
    .filter(a => a.perceivedExertion == null)
    .slice(0, FEEDBACK_FETCH_LIMIT);

  if (missing.length === 0) {
    logger.info('[Activities] Feedback: all recent activities already have RPE data');
    return;
  }

  const client = getGarminClient();
  logger.info(`[Activities] Fetching feedback (RPE/feel) for ${missing.length} activit${missing.length === 1 ? 'y' : 'ies'} via detail endpoint…`);

  for (const act of missing) {
    try {
      const detail  = await client.getActivity({ activityId: act.activityId }) as any;
      const summary = detail?.summaryDTO;
      if (!summary) continue;

      const rawRpe  = summary.directWorkoutRpe;
      const rawFeel = summary.directWorkoutFeel;

      if (rawRpe == null && rawFeel == null) continue;

      // Convert Garmin's 0–100 internal scale to human-readable units (for logging only)
      const rpe     = rawRpe  != null ? toRpe(rawRpe)     : null;
      const feeling = rawFeel != null ? toFeeling(rawFeel) : null;

      // Store the raw Garmin values — display layer converts them
      updateActivityFeedback(String(act.activityId), rawRpe ?? null, rawFeel ?? null);
      logger.info(`[Activities] Feedback stored for ${act.activityId}: raw RPE=${rawRpe ?? '-'} (→${rpe ?? '-'}/10), raw feel=${rawFeel ?? '-'} (→${feeling ?? '-'}/5)`);
    } catch (err: any) {
      logger.warn(`[Activities] Failed to fetch feedback for ${act.activityId}: ${err.message}`);
    }
  }
};
