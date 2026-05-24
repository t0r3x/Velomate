import { getGarminClient, trySessionAuth } from './garmin.service';
import { calculateDefaultZones, loadProfile } from './profile.service';

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
  console.log('[Activities] All activities from Garmin:', JSON.stringify(sample, null, 2));

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
    console.log(`[Activities] Fields with data on first activity: ${nonNullFields.join(', ')}`);
  }

  const mapped = cyclingActivities.map(act => {
    // Extract Garmin's 5-zone time distribution (seconds per zone, index 0=z1 … 4=z5).
    // Garmin may return this as hrTimeInHrZone or timeInHrZone depending on the API version.
    const rawZones =
      (act as any).hrTimeInHrZone ||
      (act as any).timeInHrZone   ||
      null;

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

  console.log(`[Activities] Zone data found for ${zonesFoundCount}/${mapped.length} cycling activities`);
  console.log(`[Activities] RPE data found for ${rpeFoundCount}/${mapped.length} cycling activities`);
  return mapped;
};

export const assessProgression = (activities: any[]) => {
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
  let estimatedLthr = Math.round(estimatedMaxHr * 0.88);

  return {
    totalCyclingRides: activities.length,
    maxRecordedHr,
    estimatedMaxHr,
    estimatedLthr,
    averageRideDurationMinutes: Math.round(averageRideDuration / 60),
    suggestedZones: calculateDefaultZones(estimatedLthr, estimatedMaxHr)
  };
};
