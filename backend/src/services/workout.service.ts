import fs from 'fs';
import path from 'path';
import {
  WorkoutBuilder,
  Step,
  StepType,
  TimeDuration,
  HrmTarget,
  WorkoutType
} from '@flow-js/garmin-connect';
import { getGarminClient, trySessionAuth } from './garmin.service';
import { getStoredProfile, loadProfile } from './profile.service';
import { getStoredActivities } from './database.service';

/** Write workout definitions to ./tmp/garmin-workouts/{timestamp}/ for dev inspection. */
const devDumpWorkouts = (workoutDefs: Record<string, any>, dateStr: string): void => {
  if (process.env.DEV_WORKOUT_DUMP !== 'true') return;
  try {
    const ts      = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dumpDir = path.join(__dirname, '../../../tmp/garmin-workouts', ts);
    fs.mkdirSync(dumpDir, { recursive: true });
    for (const [name, def] of Object.entries(workoutDefs)) {
      const file = path.join(dumpDir, `${name}.json`);
      fs.writeFileSync(file, JSON.stringify(def, null, 2), 'utf-8');
    }
    console.log(`[Dev] Workout definitions dumped to: ${dumpDir}`);
    console.log(`[Dev]   scheduleDate: ${dateStr}`);
    Object.keys(workoutDefs).forEach(n => console.log(`[Dev]   ${n}.json`));
  } catch (err: any) {
    console.warn('[Dev] Failed to dump workouts:', err.message);
  }
};

export const syncAndScheduleWorkouts = async (scheduleDate?: string) => {
  const isAuthenticated = await trySessionAuth();
  if (!isAuthenticated) {
    throw new Error('Not authenticated.');
  }

  const client = getGarminClient();

  // Use DB profile (most up-to-date), fall back to config.json
  const profile = getStoredProfile() ?? loadProfile();

  // Calculate long ride duration from stored activities (no live Garmin call needed)
  const storedActs = getStoredActivities();
  let longRideDurationMinutes = 120;
  if (storedActs.length > 0) {
    const recent   = storedActs.slice(0, 20);
    const avgMin   = recent.reduce((s, a) => s + (a.durationMinutes || 0), 0) / recent.length;
    longRideDurationMinutes = Math.min(240, Math.max(90, Math.round(avgMin * 1.2)));
  }

  const results: { type: string; workoutId: any; name: string }[] = [];
  const dateStr = scheduleDate || new Date().toISOString().split('T')[0];

  // ── 1. Sprint ────────────────────────────────────────────────────────────────
  const sprintBuilder = new WorkoutBuilder(
    WorkoutType.Cycling,
    `INNERJOIN Sprint — ${profile.lthr} LTHR`,
    'Sprint intervals targeted to heart rate zones'
  );
  sprintBuilder.addStep(new Step(StepType.WarmUp,  TimeDuration.fromMinutes(10), new HrmTarget(profile.zones.z2.min, profile.zones.z2.max), 'Warm-up Z2'));
  for (let i = 0; i < 6; i++) {
    sprintBuilder.addStep(new Step(StepType.Run,      TimeDuration.fromSeconds(30), new HrmTarget(profile.zones.z5.min, profile.zones.z5.max), `Sprint ${i+1}/6 — Z5`));
    sprintBuilder.addStep(new Step(StepType.Recovery, TimeDuration.fromMinutes(4),  new HrmTarget(profile.zones.z1.min, profile.zones.z1.max), `Recovery ${i+1}/6 — Z1`));
  }
  sprintBuilder.addStep(new Step(StepType.Cooldown, TimeDuration.fromMinutes(10), new HrmTarget(profile.zones.z1.min, profile.zones.z1.max), 'Cool-down Z1'));
  const sprintDef = sprintBuilder.build();

  // ── 2. Threshold ─────────────────────────────────────────────────────────────
  const thresholdBuilder = new WorkoutBuilder(
    WorkoutType.Cycling,
    `INNERJOIN Threshold — ${profile.lthr} LTHR`,
    'Threshold intervals (Z4) to increase aerobic power'
  );
  thresholdBuilder.addStep(new Step(StepType.WarmUp,  TimeDuration.fromMinutes(10), new HrmTarget(profile.zones.z2.min, profile.zones.z2.max), 'Warm-up Z2'));
  for (let i = 0; i < 3; i++) {
    thresholdBuilder.addStep(new Step(StepType.Run,      TimeDuration.fromMinutes(8), new HrmTarget(profile.zones.z4.min, profile.zones.z4.max), `Threshold ${i+1}/3 — Z4`));
    thresholdBuilder.addStep(new Step(StepType.Recovery, TimeDuration.fromMinutes(4), new HrmTarget(profile.zones.z1.min, profile.zones.z2.max), `Recovery ${i+1}/3 — Z1/Z2`));
  }
  thresholdBuilder.addStep(new Step(StepType.Cooldown, TimeDuration.fromMinutes(10), new HrmTarget(profile.zones.z1.min, profile.zones.z1.max), 'Cool-down Z1'));
  const thresholdDef = thresholdBuilder.build();

  // ── 3. Long Ride ─────────────────────────────────────────────────────────────
  const longRideBuilder = new WorkoutBuilder(
    WorkoutType.Cycling,
    `INNERJOIN Long Ride — ${longRideDurationMinutes} min`,
    'Steady endurance ride scaled to recent training volume'
  );
  longRideBuilder.addStep(new Step(StepType.Run, TimeDuration.fromMinutes(longRideDurationMinutes), new HrmTarget(profile.zones.z2.min, profile.zones.z2.max), 'Steady Z2 endurance'));
  const longRideDef = longRideBuilder.build();

  // ── Dev dump (DEV_WORKOUT_DUMP=true in .env) ──────────────────────────────────
  devDumpWorkouts({ sprint: sprintDef, threshold: thresholdDef, longride: longRideDef }, dateStr);

  // ── Upload to Garmin ──────────────────────────────────────────────────────────
  console.log('[Sync] Uploading Sprint workout…');
  const sprintWorkout = await client.createWorkout(sprintDef);
  results.push({ type: 'Sprint', workoutId: sprintWorkout.workoutId, name: sprintWorkout.workoutName });

  console.log('[Sync] Uploading Threshold workout…');
  const thresholdWorkout = await client.createWorkout(thresholdDef);
  results.push({ type: 'Threshold', workoutId: thresholdWorkout.workoutId, name: thresholdWorkout.workoutName });

  console.log('[Sync] Uploading Long Ride workout…');
  const longRideWorkout = await client.createWorkout(longRideDef);
  results.push({ type: 'LongRide', workoutId: longRideWorkout.workoutId, name: longRideWorkout.workoutName });

  console.log(`[Sync] Scheduling Threshold (${thresholdWorkout.workoutName}) for ${dateStr}`);
  await client.scheduleWorkout({ workoutId: String(thresholdWorkout.workoutId) }, dateStr);

  console.log(`[Sync] Done — uploaded ${results.length} workouts, Threshold scheduled for ${dateStr}, long ride = ${longRideDurationMinutes} min`);

  return {
    scheduledWorkoutId: thresholdWorkout.workoutId,
    scheduledDate:      dateStr,
    workouts:           results,
    profileUsed:        profile,
    dynamicLongRideMinutes: longRideDurationMinutes
  };
};
