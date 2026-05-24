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

  /** Build a Garmin WorkoutDef from an AI-generated (or fallback) structure. */
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

  /**
   * Find the AI-provided structure for a type from the plan.
   * Returns the structure + whether it was AI-provided (for logging).
   */
  const resolveStructure = (type: string): { structure: WorkoutStructure; aiProvided: boolean } => {
    const entry = planEntries?.find(e => e.type === type && e.status === 'planned' && e.structure);
    if (entry?.structure) return { structure: entry.structure, aiProvided: true };
    console.warn(`[Sync] No AI structure for ${type} — using fallback defaults`);
    return { structure: FALLBACK_STRUCTURES[type]!, aiProvided: false };
  };

  const dateStr = scheduleDate || new Date().toISOString().split('T')[0];
  const results: { type: string; workoutId: any; name: string }[] = [];

  // ── 1. Sprint ────────────────────────────────────────────────────────────────
  const { structure: sprintStr, aiProvided: sprintAI } = resolveStructure('Sprint');
  const sprintTotal = Math.round(sprintStr.steps.reduce((s, st) => s + st.durationSec, 0) / 60);
  console.log(`[Sync] Sprint: ${sprintAI ? 'AI' : 'fallback'} — ${sprintTotal} min, ${sprintStr.steps.length} steps`);
  const sprintDef = buildFromStructure(
    `INNERJOIN Sprint — ${profile.lthr} LTHR`,
    'Sprint intervals targeted to heart rate zones',
    sprintStr
  );

  // ── 2. Threshold ─────────────────────────────────────────────────────────────
  const { structure: threshStr, aiProvided: threshAI } = resolveStructure('Threshold');
  const threshTotal = Math.round(threshStr.steps.reduce((s, st) => s + st.durationSec, 0) / 60);
  console.log(`[Sync] Threshold: ${threshAI ? 'AI' : 'fallback'} — ${threshTotal} min, ${threshStr.steps.length} steps`);
  const thresholdDef = buildFromStructure(
    `INNERJOIN Threshold — ${profile.lthr} LTHR`,
    'Threshold intervals (Z4) to increase aerobic power',
    threshStr
  );

  // ── 3. Long Ride ─────────────────────────────────────────────────────────────
  const { structure: longStr, aiProvided: longAI } = resolveStructure('LongRide');
  const longTotal = Math.round(longStr.steps.reduce((s, st) => s + st.durationSec, 0) / 60);
  console.log(`[Sync] LongRide: ${longAI ? 'AI' : 'fallback'} — ${longTotal} min, ${longStr.steps.length} steps`);
  const longRideDef = buildFromStructure(
    `INNERJOIN Long Ride — ${longTotal} min`,
    'Steady endurance ride scaled to recent training volume',
    longStr
  );

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

  console.log(`[Sync] Done — Sprint ${sprintTotal} min (${sprintAI ? 'AI' : 'fallback'}), Threshold ${threshTotal} min (${threshAI ? 'AI' : 'fallback'}), LongRide ${longTotal} min (${longAI ? 'AI' : 'fallback'}), scheduled for ${dateStr}`);

  return {
    scheduledWorkoutId: thresholdWorkout.workoutId,
    scheduledDate:      dateStr,
    workouts:           results,
    profileUsed:        profile
  };
};
