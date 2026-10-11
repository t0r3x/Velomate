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

// ── Structure sanitising ──────────────────────────────────────────────────────
// The model's step list goes to the athlete's watch, so it is checked here rather than
// trusted. Without this, a 0-second cool-down, a negative duration, a missing zone or an
// unknown step type went straight to Garmin (and a missing zone crashed the detail panel).

const STEP_TYPES: WorkoutStep['stepType'][] = ['WarmUp', 'Run', 'Recovery', 'Cooldown'];
const INTERVAL_TYPES = ['Sprint', 'VO2Max', 'Threshold', 'Tempo'];

/** Shortest work/recovery step worth a timer — the prompt's own minimum for a sprint. */
const MIN_STEP_SEC = 20;
/** Warm-up and cool-down below this are a token gesture, not a warm-up. */
const MIN_EASE_SEC = 300;
/** Longest single step — the LongRide ceiling in WORKOUT_TYPE_GUIDELINES. */
const MAX_STEP_SEC = 14400;

const DEFAULT_ZONE: Record<WorkoutStep['stepType'], WorkoutStep['zone']> = {
  WarmUp: 'z2', Run: 'z2', Recovery: 'z1', Cooldown: 'z1'
};
/** A work step with no usable zone takes the zone its session type is built around. */
const WORK_ZONE: Record<string, WorkoutStep['zone']> = {
  Sprint: 'z5', VO2Max: 'z5', Threshold: 'z4', Tempo: 'z3', LongRide: 'z2'
};
/** A recovery between intervals that came back without a usable length. */
const DEFAULT_RECOVERY_SEC = 180;

const DEFAULT_LABEL: Record<WorkoutStep['stepType'], string> = {
  WarmUp: 'Warm-up', Run: 'Main set', Recovery: 'Recovery', Cooldown: 'Cool-down'
};

/** "VO2 Max", "longride", "Long Ride" → the canonical type, or null when unrecognisable. */
export const normalizeWorkoutType = (raw: unknown): string | null => {
  const key = String(raw ?? '').replace(/[\s_-]/g, '').toLowerCase();
  return ['Sprint', 'VO2Max', 'Threshold', 'Tempo', 'LongRide', 'Rest'].find(t => t.toLowerCase() === key) ?? null;
};

/**
 * Turn whatever the model returned into a structure that is safe and useful on a watch.
 * Returns null when nothing usable is left — sync then falls back to FALLBACK_STRUCTURES.
 *
 * - Every step gets a known stepType, a z1-z5 zone, a label and an integer duration.
 * - No dead blocks: a work step under 20s is dropped. A warm-up or cool-down missing its
 *   duration or shorter than 5 min is raised to 5 min, and a recovery missing its duration
 *   or shorter than a minute gets 3 min — those were clearly meant to be there, and dropping
 *   a recovery would glue two intervals together.
 * - A Recovery straight into the Cool-down becomes one Cool-down: two back-to-back easy
 *   blocks are one block with an extra button press. The guidelines' "N sets of
 *   [work → recovery]" invited exactly that after the last interval.
 * - Adjacent easy steps of the same type and zone are merged; adjacent work steps only on a
 *   LongRide (two Z2 blocks would otherwise be two separate Lap-press steps). On an interval
 *   session two work steps in a row stay two intervals.
 * - A trailing Recovery becomes the Cool-down; an interval session missing its warm-up or
 *   cool-down gets one, so no hard session starts cold or stops dead.
 * - It must contain at least one Run (work) step.
 */
export const sanitizeStructure = (raw: any, type: string): WorkoutStructure | null => {
  if (!raw || !Array.isArray(raw.steps)) return null;

  const cleaned: WorkoutStep[] = [];
  for (const s of raw.steps) {
    if (!s || typeof s !== 'object') continue;
    const stepKey  = String(s.stepType ?? '').replace(/[\s_-]/g, '').toLowerCase();
    const stepType = STEP_TYPES.find(t => t.toLowerCase() === stepKey) ?? 'Run';
    const isEase   = stepType === 'WarmUp' || stepType === 'Cooldown';

    let dur = Math.round(Number(s.durationSec));
    const valid = Number.isFinite(dur) && dur > 0;
    if (isEase) {
      dur = valid ? Math.max(dur, MIN_EASE_SEC) : MIN_EASE_SEC;
    } else if (stepType === 'Recovery') {
      dur = valid && dur >= 60 ? dur : DEFAULT_RECOVERY_SEC;
    } else if (!valid || dur < MIN_STEP_SEC) {
      continue;                        // a zero-length work interval is noise — drop it
    }
    dur = Math.min(dur, MAX_STEP_SEC);

    const zoneDigit = String(s.zone ?? '').match(/[1-5]/);   // "Z2", "z1/z2" → first zone named
    const zone  = zoneDigit
      ? (`z${zoneDigit[0]}` as WorkoutStep['zone'])
      : (stepType === 'Run' ? (WORK_ZONE[type] ?? DEFAULT_ZONE.Run) : DEFAULT_ZONE[stepType]);
    const label = typeof s.label === 'string' && s.label.trim() ? s.label.trim() : DEFAULT_LABEL[stepType];
    cleaned.push({ stepType, durationSec: dur, zone, label });
  }

  const steps: WorkoutStep[] = [];
  for (const st of cleaned) {
    const prev = steps[steps.length - 1];
    if (prev && prev.stepType === 'Recovery' && st.stepType === 'Cooldown') {
      steps[steps.length - 1] = { ...st, durationSec: Math.min(prev.durationSec + st.durationSec, MAX_STEP_SEC) };
      continue;
    }
    const mergeable = st.stepType !== 'Run' || !INTERVAL_TYPES.includes(type);
    if (prev && mergeable && prev.stepType === st.stepType && prev.zone === st.zone) {
      steps[steps.length - 1] = { ...prev, durationSec: Math.min(prev.durationSec + st.durationSec, MAX_STEP_SEC) };
      continue;
    }
    steps.push(st);
  }

  if (!steps.some(st => st.stepType === 'Run')) return null;

  const last = steps[steps.length - 1];
  if (last.stepType === 'Recovery') {
    steps[steps.length - 1] = { ...last, stepType: 'Cooldown', zone: 'z1', label: DEFAULT_LABEL.Cooldown, durationSec: Math.max(last.durationSec, MIN_EASE_SEC) };
  }
  if (INTERVAL_TYPES.includes(type)) {
    if (steps[0].stepType !== 'WarmUp') {
      steps.unshift({ stepType: 'WarmUp', durationSec: 600, zone: 'z2', label: DEFAULT_LABEL.WarmUp });
    }
    if (steps[steps.length - 1].stepType !== 'Cooldown') {
      steps.push({ stepType: 'Cooldown', durationSec: 480, zone: 'z1', label: DEFAULT_LABEL.Cooldown });
    }
  }

  return {
    totalMinutes: Math.round(steps.reduce((sum, st) => sum + st.durationSec, 0) / 60),
    steps
  };
};

/**
 * Fallback structures used only when the AI plan has no structure for a given type.
 * The last work interval goes straight into the cool-down — no Recovery after it.
 */
const FALLBACK_STRUCTURES: Record<string, WorkoutStructure> = {
  Sprint: {
    totalMinutes: 43,
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
      { stepType: 'Cooldown', durationSec: 600, zone: 'z1', label: 'Cool-down Z1' },
    ]
  },
  Threshold: {
    totalMinutes: 52,
    steps: [
      { stepType: 'WarmUp',   durationSec: 600, zone: 'z2', label: 'Warm-up Z2' },
      { stepType: 'Run',      durationSec: 480, zone: 'z4', label: 'Threshold 1/3 — Z4' },
      { stepType: 'Recovery', durationSec: 240, zone: 'z1', label: 'Recovery 1/3 — Z1' },
      { stepType: 'Run',      durationSec: 480, zone: 'z4', label: 'Threshold 2/3 — Z4' },
      { stepType: 'Recovery', durationSec: 240, zone: 'z1', label: 'Recovery 2/3 — Z1' },
      { stepType: 'Run',      durationSec: 480, zone: 'z4', label: 'Threshold 3/3 — Z4' },
      { stepType: 'Cooldown', durationSec: 600, zone: 'z1', label: 'Cool-down Z1' },
    ]
  },
  VO2Max: {
    totalMinutes: 43,
    steps: [
      { stepType: 'WarmUp',   durationSec: 600, zone: 'z2', label: 'Warm-up Z2' },
      { stepType: 'Run',      durationSec: 240, zone: 'z5', label: 'VO2 Max 1/4 — Z5' },
      { stepType: 'Recovery', durationSec: 180, zone: 'z1', label: 'Recovery 1/4 — Z1' },
      { stepType: 'Run',      durationSec: 240, zone: 'z5', label: 'VO2 Max 2/4 — Z5' },
      { stepType: 'Recovery', durationSec: 180, zone: 'z1', label: 'Recovery 2/4 — Z1' },
      { stepType: 'Run',      durationSec: 240, zone: 'z5', label: 'VO2 Max 3/4 — Z5' },
      { stepType: 'Recovery', durationSec: 180, zone: 'z1', label: 'Recovery 3/4 — Z1' },
      { stepType: 'Run',      durationSec: 240, zone: 'z5', label: 'VO2 Max 4/4 — Z5' },
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

/** Get HRM target for a zone key (z1–z5) from an HR profile. */
const zoneTarget = (profile: any, zoneKey: string): HrmTarget => {
  const z = (profile?.zones as any)?.[zoneKey];
  return z ? new HrmTarget(z.min, z.max) : new HrmTarget(0, 220);
};

/** Build a Garmin WorkoutDef from a structure.
 *
 * LongRide uses LapPressDuration for the main ride block so the workout never
 * ends prematurely — the athlete presses Lap when they are done, regardless of
 * how long they ride. Sprint and Threshold keep precise TimeDuration timers.
 */
const buildFromStructure = (
  profile: any,
  name: string,
  description: string,
  structure: WorkoutStructure,
  workoutType: string
) => {
  const isLongRide = workoutType === 'LongRide';
  // Open-ended only when the LongRide is ONE ride block. With two work blocks (e.g. 40 min Z2
  // then 10 min Z3) making each Lap-press would throw away the planned durations.
  const openEnded  = isLongRide && structure.steps.filter(s => s.stepType === 'Run').length === 1;
  const builder = new WorkoutBuilder(WorkoutType.Cycling, name, description);
  for (const step of structure.steps) {
    const stepType = STEP_TYPE_MAP[step.stepType] ?? StepType.Run;
    // LongRide main block: open-ended — athlete presses Lap to end.
    // All other steps (including WarmUp/Cooldown on interval workouts) use a fixed timer.
    const useOpenEnd = openEnded && step.stepType === 'Run';
    const duration   = useOpenEnd
      ? new LapPressDuration()
      : TimeDuration.fromSeconds(step.durationSec);
    builder.addStep(new Step(
      stepType,
      duration,
      zoneTarget(profile, step.zone),
      step.label
    ));
  }
  return builder.build();
};

/** Human-readable date prefix used in workout names, e.g. "Sat 14 Jun". */
const dateLabelFor = (dateStr: string): string =>
  new Date(dateStr + 'T12:00:00').toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short'
  });

/**
 * Workout name + description for a type on a given date. The date prefix is what makes a
 * workout traceable on the device and in the Garmin calendar — in free training mode it is
 * the only date the workout has, since the suggestion itself is dateless until synced.
 */
const workoutLabels = (type: string, dateStr: string): { name: string; description: string } => {
  const prefix = `${APP_NAME} - ${dateLabelFor(dateStr)}: `;
  switch (type) {
    case 'Sprint':
      return { name: `${prefix}Sprint`, description: 'Sprint intervals targeted to heart rate zones' };
    case 'VO2Max':
      return { name: `${prefix}VO2 Max`, description: 'VO2 Max intervals (Z5, 4 min) to raise aerobic ceiling' };
    case 'Threshold':
      return { name: `${prefix}Threshold`, description: 'Threshold intervals (Z4) to increase aerobic power' };
    case 'Tempo':
      return { name: `${prefix}Tempo`, description: 'Tempo / sweet spot blocks (Z3) to build fatigue resistance' };
    default:
      return { name: `${prefix}Long Ride`, description: 'Steady Z2 endurance ride — press Lap when done' };
  }
};

export const syncAndScheduleWorkouts = async (planEntries?: PlanEntry[], scheduleDate?: string) => {
  const isAuthenticated = await trySessionAuth();
  if (!isAuthenticated) throw new Error('Not authenticated.');

  const client  = getGarminClient();
  const profile = getStoredProfile() ?? loadProfile();

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
    // Sanitised here as well as at generation time, so plans stored before the check existed
    // never put a dead block on the watch either.
    let structure: WorkoutStructure;
    let aiProvided: boolean;
    const cleaned = sanitizeStructure(entry.structure, type);
    if (cleaned) {
      structure  = cleaned;
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

    // Resolve date first — the date prefix in the name makes workouts easy to identify
    // on the device and in the Garmin calendar
    const entryDate = entry.date || dateStr;
    const { name: workoutName, description: workoutDesc } = workoutLabels(type, entryDate);

    const def = buildFromStructure(profile, workoutName, workoutDesc, structure, type);
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

/**
 * Upload and schedule ONE workout for free training mode.
 *
 * Free suggestions have no date of their own, so the date the athlete pressed the button
 * becomes the workout's date: it goes into the workout name ("Velomate - Wed 27 Aug: Tempo")
 * and onto the Garmin calendar for that day. That is what makes a synced suggestion traceable
 * afterwards — you can always see which day you asked for it.
 *
 * Unlike the plan sync, this does NOT wipe every "Velomate - " workout first. Previously
 * synced free workouts are the athlete's history and must survive; only an exact name clash
 * (same type synced twice on the same day) is removed, so pressing the button again replaces
 * rather than duplicates.
 */
export const syncFreeWorkout = async (
  type: string,
  structure: WorkoutStructure | null,
  scheduleDate?: string
) => {
  const isAuthenticated = await trySessionAuth();
  if (!isAuthenticated) throw new Error('Not authenticated.');

  if (type === 'Rest') throw new Error('A Rest suggestion has no workout to sync.');

  const client  = getGarminClient();
  const profile = getStoredProfile() ?? loadProfile();
  const dateStr = scheduleDate || localDate();

  // Prefer the AI structure; fall back to the built-in template only if it is missing.
  const usingFallback: string[] = [];
  let resolved: WorkoutStructure;
  const cleaned = sanitizeStructure(structure, type);
  if (cleaned) {
    resolved = cleaned;
  } else if (FALLBACK_STRUCTURES[type]) {
    logger.warn(`[Sync] Free mode: no AI structure for ${type} — using built-in fallback`);
    resolved = FALLBACK_STRUCTURES[type]!;
    usingFallback.push(type);
  } else {
    throw new Error(`No workout structure available for ${type}. Refresh the suggestion first.`);
  }

  const { name: workoutName, description: workoutDesc } = workoutLabels(type, dateStr);
  const totalMin = Math.round(resolved.steps.reduce((s, st) => s + st.durationSec, 0) / 60);
  logger.info(`[Sync] Free mode: ${type} for ${dateStr} — ${totalMin} min, ${resolved.steps.length} steps`);

  // Remove only an identically-named workout — re-syncing the same suggestion on the same
  // day replaces it, while every earlier free workout stays in the library as history.
  try {
    const existingWorkouts = await client.getWorkouts(0, 100) as any[];
    const clashes = existingWorkouts.filter((w: any) => w.workoutName === workoutName);
    for (const w of clashes) {
      logger.info(`[Sync] Free mode: replacing existing "${w.workoutName}" (id ${w.workoutId})`);
      await client.deleteWorkout({ workoutId: String(w.workoutId) });
    }
  } catch (err: any) {
    // Non-fatal: worst case the athlete ends up with a duplicate entry.
    logger.warn(`[Sync] Free mode: could not check for an existing workout (continuing anyway): ${err.message}`);
  }

  const def = buildFromStructure(profile, workoutName, workoutDesc, resolved, type);
  devDumpWorkouts({ [`${dateStr}_${type.toLowerCase()}_free`]: def }, dateStr);

  let uploaded: any;
  try {
    uploaded = await client.createWorkout(def);
  } catch (err: any) {
    throw new Error(`Failed to upload ${type} workout: ${err.message}`);
  }

  // Upload succeeded — a scheduling failure still leaves a usable workout in the library,
  // so report it instead of failing the whole sync.
  let scheduleError = '';
  let scheduledDate = dateStr;
  try {
    logger.info(`[Sync] Free mode: scheduling ${type} (${uploaded.workoutName}) for ${dateStr}`);
    await client.scheduleWorkout({ workoutId: String(uploaded.workoutId) }, dateStr);
  } catch (err: any) {
    logger.warn(`[Sync] Free mode: ${type} uploaded (id ${uploaded.workoutId}) but scheduling failed: ${err.message}`);
    scheduleError = `Could not schedule for ${dateStr} — schedule manually in Garmin Connect`;
    scheduledDate = '';
  }

  return {
    scheduledDate:  dateStr,
    workouts:       [{ type, workoutId: uploaded.workoutId, name: uploaded.workoutName, scheduledDate, scheduleError }],
    usingFallback,
    scheduleErrors: scheduleError ? [`${type}: ${scheduleError}`] : [],
    profileUsed:    profile
  };
};
