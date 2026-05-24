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
import { loadProfile } from './profile.service';
import { getStoredProfile, PlanEntry, WorkoutStep, WorkoutStructure } from './database.service';

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

  /** Build a Garmin WorkoutDef from a structure. */
  const buildFromStructure = (
    name: string,
    description: string,
    structure: WorkoutStructure
  ) => {
    const builder = new WorkoutBuilder(WorkoutType.Cycling, name, description);
    for (const step of structure.steps) {
      const stepType = STEP_TYPE_MAP[step.stepType] ?? StepType.Run;
      builder.addStep(new Step(
        stepType,
        TimeDuration.fromSeconds(step.durationSec),
        zoneTarget(step.zone),
        step.label
      ));
    }
    return builder.build();
  };

  const dateStr = scheduleDate || new Date().toISOString().split('T')[0];
  const results: { type: string; workoutId: any; name: string; scheduledDate: string; scheduleError: string }[] = [];
  const usingFallback: string[] = [];   // tracks which types had no AI structure

  // ── Derive which workout types to sync from the plan ──────────────────────────
  // Only sync types that are actually planned — never upload workouts for types not in the plan.
  const SYNCABLE_TYPES = ['Sprint', 'Threshold', 'LongRide'] as const;
  type SyncType = typeof SYNCABLE_TYPES[number];

  // Build a map: type → first planned entry with that type (AI structure preferred)
  const plannedEntryByType = new Map<string, PlanEntry>();
  for (const entry of (planEntries || [])) {
    if (entry.status === 'planned' && SYNCABLE_TYPES.includes(entry.type as SyncType)) {
      if (!plannedEntryByType.has(entry.type)) {
        plannedEntryByType.set(entry.type, entry);
      }
    }
  }

  // If the plan is empty or has no syncable types, fall back to all three so the button
  // is never a no-op (e.g. first-time sync before plan is generated).
  if (plannedEntryByType.size === 0) {
    console.warn('[Sync] No planned syncable entries found — falling back to all three types');
    for (const type of SYNCABLE_TYPES) {
      plannedEntryByType.set(type, { date: dateStr, type, reason: '', status: 'planned', structure: null });
    }
  }

  const typesToSync = [...plannedEntryByType.keys()];
  console.log(`[Sync] Syncing ${typesToSync.length} workout type(s) from plan: ${typesToSync.join(', ')}`);

  // ── Build and upload each planned type ───────────────────────────────────────
  const devDump: Record<string, any> = {};
  let scheduledWorkoutId: any = null;

  for (const type of typesToSync) {
    const entry = plannedEntryByType.get(type)!;

    // Resolve structure: AI-generated is always preferred.
    // Fallback only fires if the plan has the type but no structure (shouldn't normally happen).
    let structure: WorkoutStructure;
    let aiProvided: boolean;
    if (entry.structure?.steps?.length) {
      structure  = entry.structure;
      aiProvided = true;
    } else if (FALLBACK_STRUCTURES[type]) {
      console.warn(`[Sync] No AI structure for ${type} — using built-in fallback`);
      structure  = FALLBACK_STRUCTURES[type]!;
      aiProvided = false;
    } else {
      throw new Error(`No workout structure available for ${type}. Regenerate the AI plan first.`);
    }

    const totalMin = Math.round(structure.steps.reduce((s, st) => s + st.durationSec, 0) / 60);
    console.log(`[Sync] ${type}: ${aiProvided ? 'AI' : 'fallback'} — ${totalMin} min, ${structure.steps.length} steps`);
    if (!aiProvided) usingFallback.push(type);

    // Build workout name
    let workoutName: string;
    let workoutDesc: string;
    if (type === 'Sprint') {
      workoutName = `INNERJOIN Sprint`;
      workoutDesc = 'Sprint intervals targeted to heart rate zones';
    } else if (type === 'Threshold') {
      workoutName = `INNERJOIN Threshold`;
      workoutDesc = 'Threshold intervals (Z4) to increase aerobic power';
    } else {
      workoutName = `INNERJOIN Long Ride`;
      workoutDesc = 'Steady endurance ride scaled to recent training volume';
    }

    const def = buildFromStructure(workoutName, workoutDesc, structure);
    devDump[type.toLowerCase()] = def;

    // Upload the workout definition
    console.log(`[Sync] Uploading ${type} workout…`);
    let uploaded: any;
    try {
      uploaded = await client.createWorkout(def);
    } catch (err: any) {
      throw new Error(`Failed to upload ${type} workout: ${err.message}`);
    }

    // Schedule on the workout's own plan date
    const entryDate = entry.date || dateStr;
    try {
      console.log(`[Sync] Scheduling ${type} (${uploaded.workoutName}) for ${entryDate}`);
      await client.scheduleWorkout({ workoutId: String(uploaded.workoutId) }, entryDate);
    } catch (err: any) {
      // createWorkout succeeded but scheduleWorkout failed — workout is now in the library
      // but not on the calendar. Tell the user explicitly so they can schedule it manually.
      console.warn(`[Sync] ${type} uploaded (id ${uploaded.workoutId}) but scheduling failed: ${err.message}`);
      results.push({
        type,
        workoutId:     uploaded.workoutId,
        name:          uploaded.workoutName,
        scheduledDate: '',
        scheduleError: `Could not schedule for ${entryDate} — schedule manually in Garmin Connect`
      });
      if (type === 'Threshold') scheduledWorkoutId = uploaded.workoutId;
      continue;
    }

    results.push({
      type,
      workoutId:     uploaded.workoutId,
      name:          uploaded.workoutName,
      scheduledDate: entryDate,
      scheduleError: ''
    });

    if (type === 'Threshold') scheduledWorkoutId = uploaded.workoutId;
  }

  devDumpWorkouts(devDump, dateStr);
  const scheduleErrors = results.filter(r => r.scheduleError).map(r => `${r.type}: ${r.scheduleError}`);
  console.log(`[Sync] Done — ${results.length} workout(s) uploaded${scheduleErrors.length ? `, ${scheduleErrors.length} scheduling error(s)` : ', all scheduled'}`);
  if (usingFallback.length) console.warn(`[Sync] Fallback structures used for: ${usingFallback.join(', ')}`);

  return {
    scheduledWorkoutId,
    scheduledDate:  dateStr,
    workouts:       results,
    usingFallback,           // non-empty → frontend should warn user to regenerate plan
    scheduleErrors,          // non-empty → some workouts need manual scheduling
    profileUsed:    profile
  };
};
