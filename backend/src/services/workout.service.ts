import fs from 'fs';
import path from 'path';
import {
  WorkoutBuilder,
  Step,
  StepType,
  TimeDuration,
  LapPressDuration,
  HrmTarget,
  WorkoutType
} from '@flow-js/garmin-connect';
import { getGarminClient, trySessionAuth } from './garmin.service';
import { loadProfile } from './profile.service';
import { getStoredProfile, PlanEntry, WorkoutStep, WorkoutStructure } from './database.service';
import { localDate, APP_NAME } from '../utils';
import logger from '../logger';

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
    logger.info(`[Dev] Workout definitions dumped to: ${dumpDir}`);
    logger.info(`[Dev]   scheduleDate: ${dateStr}`);
    Object.keys(workoutDefs).forEach(n => logger.info(`[Dev]   ${n}.json`));
  } catch (err: any) {
    logger.warn(`[Dev] Failed to dump workouts: ${err.message}`);
  }
};

const STEP_TYPE_MAP: Record<string, StepType> = {
  WarmUp:   StepType.WarmUp,
  Run:      StepType.Run,
  Recovery: StepType.Recovery,
  Cooldown: StepType.Cooldown,
};

/** Fallback structures used only when the AI plan has no structure for a given type. */
const FALLBACK_STRUCTURES: Record<string, WorkoutStructure> = {
  Sprint: {
    totalMinutes: 47,
    steps: [
      { stepType: 'WarmUp',   durationSec: 600, zone: 'z2', label: 'Warm-up Z2' },
      { stepType: 'Run',      durationSec: 30,  zone: 'z5', label: 'Sprint 1/6 — Z5' },
      { stepType: 'Recovery', durationSec: 240, zone: 'z1', label: 'Recovery 1/6 — Z1' },
      { stepType: 'Run',      durationSec: 30,  zone: 'z5', label: 'Sprint 2/6 — Z5' },
      { stepType: 'Recovery', durationSec: 240, zone: 'z1', label: 'Recovery 2/6 — Z1' },
      { stepType: 'Run',      durationSec: 30,  zone: 'z5', label: 'Sprint 3/6 — Z5' },
      { stepType: 'Recovery', durationSec: 240, zone: 'z1', label: 'Recovery 3/6 — Z1' },
      { stepType: 'Run',      durationSec: 30,  zone: 'z5', label: 'Sprint 4/6 — Z5' },
      { stepType: 'Recovery', durationSec: 240, zone: 'z1', label: 'Recovery 4/6 — Z1' },
      { stepType: 'Run',      durationSec: 30,  zone: 'z5', label: 'Sprint 5/6 — Z5' },
      { stepType: 'Recovery', durationSec: 240, zone: 'z1', label: 'Recovery 5/6 — Z1' },
      { stepType: 'Run',      durationSec: 30,  zone: 'z5', label: 'Sprint 6/6 — Z5' },
      { stepType: 'Recovery', durationSec: 240, zone: 'z1', label: 'Recovery 6/6 — Z1' },
      { stepType: 'Cooldown', durationSec: 600, zone: 'z1', label: 'Cool-down Z1' },
    ]
  },
  Threshold: {
    totalMinutes: 56,
    steps: [
      { stepType: 'WarmUp',   durationSec: 600, zone: 'z2', label: 'Warm-up Z2' },
      { stepType: 'Run',      durationSec: 480, zone: 'z4', label: 'Threshold 1/3 — Z4' },
      { stepType: 'Recovery', durationSec: 240, zone: 'z1', label: 'Recovery 1/3 — Z1' },
      { stepType: 'Run',      durationSec: 480, zone: 'z4', label: 'Threshold 2/3 — Z4' },
      { stepType: 'Recovery', durationSec: 240, zone: 'z1', label: 'Recovery 2/3 — Z1' },
      { stepType: 'Run',      durationSec: 480, zone: 'z4', label: 'Threshold 3/3 — Z4' },
      { stepType: 'Recovery', durationSec: 240, zone: 'z1', label: 'Recovery 3/3 — Z1' },
      { stepType: 'Cooldown', durationSec: 600, zone: 'z1', label: 'Cool-down Z1' },
    ]
  },
  VO2Max: {
    totalMinutes: 46,
    steps: [
      { stepType: 'WarmUp',   durationSec: 600, zone: 'z2', label: 'Warm-up Z2' },
      { stepType: 'Run',      durationSec: 240, zone: 'z5', label: 'VO2 Max 1/4 — Z5' },
      { stepType: 'Recovery', durationSec: 180, zone: 'z1', label: 'Recovery 1/4 — Z1' },
      { stepType: 'Run',      durationSec: 240, zone: 'z5', label: 'VO2 Max 2/4 — Z5' },
      { stepType: 'Recovery', durationSec: 180, zone: 'z1', label: 'Recovery 2/4 — Z1' },
      { stepType: 'Run',      durationSec: 240, zone: 'z5', label: 'VO2 Max 3/4 — Z5' },
      { stepType: 'Recovery', durationSec: 180, zone: 'z1', label: 'Recovery 3/4 — Z1' },
      { stepType: 'Run',      durationSec: 240, zone: 'z5', label: 'VO2 Max 4/4 — Z5' },
      { stepType: 'Recovery', durationSec: 180, zone: 'z1', label: 'Recovery 4/4 — Z1' },
      { stepType: 'Cooldown', durationSec: 480, zone: 'z1', label: 'Cool-down Z1' },
    ]
  },
  Tempo: {
    totalMinutes: 63,
    steps: [
      { stepType: 'WarmUp',   durationSec: 600,  zone: 'z2', label: 'Warm-up Z2' },
      { stepType: 'Run',      durationSec: 1200, zone: 'z3', label: 'Tempo 1/2 — Z3' },
      { stepType: 'Recovery', durationSec: 300,  zone: 'z1', label: 'Recovery 1/2 — Z1' },
      { stepType: 'Run',      durationSec: 1200, zone: 'z3', label: 'Tempo 2/2 — Z3' },
      { stepType: 'Cooldown', durationSec: 480,  zone: 'z1', label: 'Cool-down Z1' },
    ]
  },
  LongRide: {
    totalMinutes: 120,
    steps: [
      { stepType: 'Run', durationSec: 7200, zone: 'z2', label: 'Steady Z2 endurance' }
    ]
  }
};

export const syncAndScheduleWorkouts = async (planEntries?: PlanEntry[], scheduleDate?: string) => {
  const isAuthenticated = await trySessionAuth();
  if (!isAuthenticated) throw new Error('Not authenticated.');

  const client  = getGarminClient();
  const profile = getStoredProfile() ?? loadProfile();

  /** Get HRM target for a zone key (z1–z5). */
  const zoneTarget = (zoneKey: string): HrmTarget => {
    const z = (profile.zones as any)[zoneKey];
    return z ? new HrmTarget(z.min, z.max) : new HrmTarget(0, 220);
  };

  /** Build a Garmin WorkoutDef from a structure.
   *
   * LongRide uses LapPressDuration for the main ride block so the workout never
   * ends prematurely — the athlete presses Lap when they are done, regardless of
   * how long they ride. Sprint and Threshold keep precise TimeDuration timers.
   */
  const buildFromStructure = (
    name: string,
    description: string,
    structure: WorkoutStructure,
    workoutType: string
  ) => {
    const isLongRide = workoutType === 'LongRide';
    const builder = new WorkoutBuilder(WorkoutType.Cycling, name, description);
    for (const step of structure.steps) {
      const stepType = STEP_TYPE_MAP[step.stepType] ?? StepType.Run;
      // LongRide main block: open-ended — athlete presses Lap to end.
      // All other steps (including WarmUp/Cooldown on interval workouts) use a fixed timer.
      const useOpenEnd = isLongRide && step.stepType === 'Run';
      const duration   = useOpenEnd
        ? new LapPressDuration()
        : TimeDuration.fromSeconds(step.durationSec);
      builder.addStep(new Step(
        stepType,
        duration,
        zoneTarget(step.zone),
        step.label
      ));
    }
    return builder.build();
  };

  const dateStr = scheduleDate || localDate();
  const results: { type: string; workoutId: any; name: string; scheduledDate: string; scheduleError: string }[] = [];
  const usingFallback: string[] = [];   // tracks which types had no AI structure

  // ── Derive which workouts to sync from the plan ────────────────────────────────
  // Only sync the visible "This Week" window (today..today+6) — matches what WeekGrid.vue
  // actually displays as the current, actionable week (the AI plan window is 14 days, so
  // without this bound the loop below would reach into next week too). Every planned
  // syncable day gets its own upload+schedule — do NOT dedupe by type, since a single week
  // can legitimately contain more than one day of the same type (e.g. two Long Rides for a
  // high-volume athlete), and each needs its own scheduled entry on Garmin.
  const SYNCABLE_TYPES = ['Sprint', 'VO2Max', 'Threshold', 'Tempo', 'LongRide'] as const;
  type SyncType = typeof SYNCABLE_TYPES[number];

  const today = localDate();
  const weekEnd = new Date(today + 'T12:00:00');
  weekEnd.setDate(weekEnd.getDate() + 6);
  const weekEndStr = localDate(weekEnd);

  let entriesToSync: PlanEntry[] = (planEntries || []).filter(
    e => e.status === 'planned'
      && SYNCABLE_TYPES.includes(e.type as SyncType)
      && e.date >= today
      && e.date <= weekEndStr
  );

  // If this week has no syncable entries, fall back to all five so the button is never
  // a no-op (e.g. first-time sync before plan is generated).
  if (entriesToSync.length === 0) {
    logger.warn('[Sync] No planned syncable entries in this week — falling back to all five types');
    entriesToSync = SYNCABLE_TYPES.map(type => ({ date: dateStr, type, reason: '', status: 'planned' as const, structure: null }));
  }

  logger.info(`[Sync] Syncing ${entriesToSync.length} workout(s) from this week: ${entriesToSync.map(e => `${e.date}:${e.type}`).join(', ')}`);

  // ── Remove existing Velomate workouts before re-uploading ────────────────────
  // Prevents duplicates in the Garmin library and calendar when syncing multiple times.
  // deleteWorkout removes the workout from the library AND all scheduled calendar entries.
  const APP_PREFIX = `${APP_NAME} - `;
  try {
    const existingWorkouts = await client.getWorkouts(0, 100) as any[];
    const toDelete = existingWorkouts.filter(
      (w: any) => typeof w.workoutName === 'string' && w.workoutName.startsWith(APP_PREFIX)
    );
    if (toDelete.length > 0) {
      logger.info(`[Sync] Removing ${toDelete.length} existing Velomate workout(s) before re-upload…`);
      await Promise.all(
        toDelete.map((w: any) => {
          logger.info(`[Sync]   Deleting: ${w.workoutName} (id ${w.workoutId})`);
          return client.deleteWorkout({ workoutId: String(w.workoutId) });
        })
      );
    } else {
      logger.info('[Sync] No existing Velomate workouts found — clean upload');
    }
  } catch (err: any) {
    // Non-fatal: log and continue. Upload will still succeed; worst case is a duplicate.
    logger.warn(`[Sync] Could not clean up existing workouts (continuing anyway): ${err.message}`);
  }

  // ── Build and upload each planned entry ──────────────────────────────────────
  const devDump: Record<string, any> = {};

  for (const entry of entriesToSync) {
    const type = entry.type;

    // Resolve structure: AI-generated is always preferred.
    // Fallback only fires if the plan has the type but no structure (shouldn't normally happen).
    let structure: WorkoutStructure;
    let aiProvided: boolean;
    if (entry.structure?.steps?.length) {
      structure  = entry.structure;
      aiProvided = true;
    } else if (FALLBACK_STRUCTURES[type]) {
      logger.warn(`[Sync] No AI structure for ${type} — using built-in fallback`);
      structure  = FALLBACK_STRUCTURES[type]!;
      aiProvided = false;
    } else {
      throw new Error(`No workout structure available for ${type}. Regenerate the AI plan first.`);
    }

    const totalMin = Math.round(structure.steps.reduce((s, st) => s + st.durationSec, 0) / 60);
    logger.info(`[Sync] ${type}: ${aiProvided ? 'AI' : 'fallback'} — ${totalMin} min, ${structure.steps.length} steps`);
    if (!aiProvided) usingFallback.push(type);

    // Resolve date first — used in the workout name so it's visible on the device
    const entryDate = entry.date || dateStr;
    const dateLabel = new Date(entryDate + 'T12:00:00').toLocaleDateString('en-GB', {
      weekday: 'short', day: 'numeric', month: 'short'
    }); // e.g. "Sat 14 Jun"

    // Build workout name — date prefix makes workouts easy to identify on the device
    let workoutName: string;
    let workoutDesc: string;
    if (type === 'Sprint') {
      workoutName = `${APP_NAME} - ${dateLabel}: Sprint`;
      workoutDesc = 'Sprint intervals targeted to heart rate zones';
    } else if (type === 'VO2Max') {
      workoutName = `${APP_NAME} - ${dateLabel}: VO2 Max`;
      workoutDesc = 'VO2 Max intervals (Z5, 4 min) to raise aerobic ceiling';
    } else if (type === 'Threshold') {
      workoutName = `${APP_NAME} - ${dateLabel}: Threshold`;
      workoutDesc = 'Threshold intervals (Z4) to increase aerobic power';
    } else if (type === 'Tempo') {
      workoutName = `${APP_NAME} - ${dateLabel}: Tempo`;
      workoutDesc = 'Tempo / sweet spot blocks (Z3) to build fatigue resistance';
    } else {
      workoutName = `${APP_NAME} - ${dateLabel}: Long Ride`;
      workoutDesc = 'Steady Z2 endurance ride — press Lap when done';
    }

    const def = buildFromStructure(workoutName, workoutDesc, structure, type);
    devDump[`${entryDate}_${type.toLowerCase()}`] = def;

    // Upload the workout definition
    logger.info(`[Sync] Uploading ${type} workout…`);
    let uploaded: any;
    try {
      uploaded = await client.createWorkout(def);
    } catch (err: any) {
      throw new Error(`Failed to upload ${type} workout: ${err.message}`);
    }
    try {
      logger.info(`[Sync] Scheduling ${type} (${uploaded.workoutName}) for ${entryDate}`);
      await client.scheduleWorkout({ workoutId: String(uploaded.workoutId) }, entryDate);
    } catch (err: any) {
      // createWorkout succeeded but scheduleWorkout failed — workout is now in the library
      // but not on the calendar. Tell the user explicitly so they can schedule it manually.
      logger.warn(`[Sync] ${type} uploaded (id ${uploaded.workoutId}) but scheduling failed: ${err.message}`);
      results.push({
        type,
        workoutId:     uploaded.workoutId,
        name:          uploaded.workoutName,
        scheduledDate: '',
        scheduleError: `Could not schedule for ${entryDate} — schedule manually in Garmin Connect`
      });
      continue;
    }

    results.push({
      type,
      workoutId:     uploaded.workoutId,
      name:          uploaded.workoutName,
      scheduledDate: entryDate,
      scheduleError: ''
    });
  }

  devDumpWorkouts(devDump, dateStr);
  const scheduleErrors = results.filter(r => r.scheduleError).map(r => `${r.type}: ${r.scheduleError}`);
  logger.info(`[Sync] Done — ${results.length} workout(s) uploaded${scheduleErrors.length ? `, ${scheduleErrors.length} scheduling error(s)` : ', all scheduled'}`);
  if (usingFallback.length) logger.warn(`[Sync] Fallback structures used for: ${usingFallback.join(', ')}`);

  return {
    scheduledDate:  dateStr,
    workouts:       results,
    usingFallback,           // non-empty → frontend should warn user to regenerate plan
    scheduleErrors,          // non-empty → some workouts need manual scheduling
    profileUsed:    profile
  };
};
