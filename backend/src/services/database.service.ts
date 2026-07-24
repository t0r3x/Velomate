import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';
import logger from '../logger';

// ── Setup ─────────────────────────────────────────────────────────────────────
// Default: %APPDATA%\velomate on Windows, ~/.velomate elsewhere.
// Outside the project directory so git clean never touches it.
const defaultDataDir = path.join(process.env.APPDATA ?? os.homedir(), 'velomate');

const dbFilePath = process.env.VELOMATE_DB_PATH
  ? path.resolve(process.env.VELOMATE_DB_PATH)
  : path.join(defaultDataDir, 'velomate.db');

const dataDir = path.dirname(dbFilePath);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// better-sqlite3's .node binary is built against one specific Node ABI at a time.
// Switching between `npm run dev`/`npm start` (system Node) and `npm run electron:dev`/
// `electron:build` (Electron's bundled Node) without rebuilding in between fails here
// with a cryptic ERR_DLOPEN_FAILED — turn it into an actionable message instead.
let db: Database.Database;
try {
  db = new Database(dbFilePath);
} catch (err: any) {
  if (err?.code === 'ERR_DLOPEN_FAILED' && /NODE_MODULE_VERSION/.test(err.message ?? '')) {
    console.error(
      '\n❌ better-sqlite3 was built for a different Node runtime than the one now running it.\n' +
      '   Fix depends on how you just started the app:\n' +
      '     • Plain Node (`npm run dev` / `npm run build` / `npm start`)      → run `npm rebuild better-sqlite3` inside backend/\n' +
      '     • Electron   (`npm run electron:dev` / `npm run electron:build`) → run `npm run electron:rebuild` from the repo root\n' +
      '   See the "better-sqlite3" gotcha in CLAUDE.md for details.\n'
    );
    process.exit(1);
  }
  throw err;
}

// WAL mode — better concurrent read performance
db.pragma('journal_mode = WAL');

// ── Schema migration: drop tables carrying the old JSON-blob shape ────────────
// Zones (profile/analysis) and per-activity zone seconds are fixed-shape data
// (5 zones × min/max, 5 zones × seconds) — normalized into real columns below
// instead of TEXT-encoded JSON. `devices` was dead (no reads/writes anywhere,
// no route) and is dropped outright. Old data is disposable, so a one-time
// DROP + recreate is simpler than an in-place ALTER migration.
const hasColumn = (table: string, column: string): boolean => {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some(c => c.name === column);
};
if (hasColumn('activities', 'timeInZones')) db.exec('DROP TABLE activities');
if (hasColumn('analysis', 'suggestedZones')) db.exec('DROP TABLE analysis');
if (hasColumn('profile', 'zones')) db.exec('DROP TABLE profile');
db.exec('DROP TABLE IF EXISTS devices');

// ── Schema ────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS activities (
    activityId    TEXT    PRIMARY KEY,
    name          TEXT,
    type          TEXT,
    startTime     TEXT,
    distanceKm    REAL    DEFAULT 0,
    durationMinutes INTEGER DEFAULT 0,
    averageHr     INTEGER DEFAULT 0,
    maxHr         INTEGER DEFAULT 0,
    averagePower  INTEGER DEFAULT 0,
    maxPower      INTEGER DEFAULT 0,
    z1Sec         INTEGER DEFAULT NULL,
    z2Sec         INTEGER DEFAULT NULL,
    z3Sec         INTEGER DEFAULT NULL,
    z4Sec         INTEGER DEFAULT NULL,
    z5Sec         INTEGER DEFAULT NULL,
    perceivedExertion     INTEGER DEFAULT NULL,
    feelingAfterExercise  INTEGER DEFAULT NULL,
    fetchedAt     TEXT    DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS analysis (
    id                        INTEGER PRIMARY KEY CHECK (id = 1),
    totalCyclingRides         INTEGER,
    maxRecordedHr             INTEGER,
    estimatedMaxHr            INTEGER,
    estimatedLthr             INTEGER,
    averageRideDurationMinutes INTEGER,
    z1min INTEGER, z1max INTEGER,
    z2min INTEGER, z2max INTEGER,
    z3min INTEGER, z3max INTEGER,
    z4min INTEGER, z4max INTEGER,
    z5min INTEGER, z5max INTEGER,
    updatedAt                 TEXT    DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS profile (
    id               INTEGER PRIMARY KEY CHECK (id = 1),
    maxHr            INTEGER,
    lthr             INTEGER,
    z1min INTEGER, z1max INTEGER,
    z2min INTEGER, z2max INTEGER,
    z3min INTEGER, z3max INTEGER,
    z4min INTEGER, z4max INTEGER,
    z5min INTEGER, z5max INTEGER,
    hasCustomOverrides INTEGER DEFAULT 0,
    lastUpdated      TEXT    DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS recommendation (
    id               INTEGER PRIMARY KEY CHECK (id = 1),
    workoutType      TEXT,
    reason           TEXT,
    priority         TEXT,
    weeklyPlan       TEXT,
    nextWeekOverview TEXT,
    loadAssessment   TEXT,
    generatedAt      TEXT
  );
`);

// ── Activities ────────────────────────────────────────────────────────────────
// UPSERT: on conflict, update all fields EXCEPT perceivedExertion/feelingAfterExercise —
// those are fetched via the detail endpoint separately and must not be overwritten by the
// bulk list sync (which never includes them).
const stmtUpsertActivity = db.prepare(`
  INSERT INTO activities
    (activityId, name, type, startTime, distanceKm, durationMinutes,
     averageHr, maxHr, averagePower, maxPower,
     z1Sec, z2Sec, z3Sec, z4Sec, z5Sec,
     perceivedExertion, feelingAfterExercise, fetchedAt)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
  ON CONFLICT(activityId) DO UPDATE SET
    name                = excluded.name,
    type                = excluded.type,
    startTime           = excluded.startTime,
    distanceKm          = excluded.distanceKm,
    durationMinutes     = excluded.durationMinutes,
    averageHr           = excluded.averageHr,
    maxHr               = excluded.maxHr,
    averagePower        = excluded.averagePower,
    maxPower            = excluded.maxPower,
    z1Sec               = excluded.z1Sec,
    z2Sec               = excluded.z2Sec,
    z3Sec               = excluded.z3Sec,
    z4Sec               = excluded.z4Sec,
    z5Sec               = excluded.z5Sec,
    fetchedAt           = excluded.fetchedAt
    -- perceivedExertion and feelingAfterExercise intentionally NOT updated here;
    -- they are set exclusively by updateActivityFeedback() after a detail fetch.
`);

const upsertManyActivities = db.transaction((activities: any[]) => {
  // Use a single timestamp for the entire batch — avoids per-row Date() calls and
  // stores a proper ISO 8601 string with Z suffix (SQLite CURRENT_TIMESTAMP omits the Z,
  // causing JavaScript to misparse it as local time instead of UTC).
  const now = new Date().toISOString();
  for (const a of activities) {
    const z = a.timeInZones;
    stmtUpsertActivity.run(
      String(a.activityId),
      a.name,
      a.type,
      a.startTime,
      a.distanceKm,
      a.durationMinutes,
      a.averageHr,
      a.maxHr,
      a.averagePower || 0,
      a.maxPower || 0,
      z?.[0] ?? null,
      z?.[1] ?? null,
      z?.[2] ?? null,
      z?.[3] ?? null,
      z?.[4] ?? null,
      now
    );
  }
});

const stmtUpdateFeedback = db.prepare(`
  UPDATE activities SET perceivedExertion = ?, feelingAfterExercise = ? WHERE activityId = ?
`);

/** Set perceived exertion (raw Garmin 0–100) and feeling (raw 0–100) for one activity.
 *  Raw scale: directWorkoutRpe 0–100, directWorkoutFeel 0–100.
 *  Display: rpe / 10 → 1–10 Borg scale, feel / 25 + 1 → 1–5 feeling scale.
 *  Pass null for either value when not available. */
export const updateActivityFeedback = (
  activityId: string,
  perceivedExertion: number | null,
  feelingAfterExercise: number | null
): void => {
  stmtUpdateFeedback.run(perceivedExertion, feelingAfterExercise, activityId);
};

export const upsertActivities = (activities: any[]): void => {
  upsertManyActivities(activities);
};

export const getStoredActivities = (): any[] => {
  const rows = db.prepare('SELECT * FROM activities ORDER BY startTime DESC').all() as any[];
  return rows.map(({ z1Sec, z2Sec, z3Sec, z4Sec, z5Sec, ...rest }) => ({
    ...rest,
    timeInZones: z1Sec != null ? [z1Sec, z2Sec, z3Sec, z4Sec, z5Sec] : null
  }));
};

export const getActivityCount = (): number => {
  const row = db.prepare('SELECT COUNT(*) as count FROM activities').get() as { count: number };
  return row.count;
};

// ── HR zones (shared shape: z1..z5, each {min, max}) ───────────────────────────
// Both `profile` and `analysis` store the same fixed 5-zone structure as flat
// z{n}min/z{n}max columns — flattened for writes, reconstructed for reads.
const flattenZones = (zones: any): number[] => {
  const zs = zones || {};
  return ['z1', 'z2', 'z3', 'z4', 'z5'].flatMap(z => [zs[z]?.min ?? null, zs[z]?.max ?? null]);
};

const zonesFromRow = (row: any): Record<string, { min: number; max: number }> | null => {
  if (row.z1min == null) return null;
  return {
    z1: { min: row.z1min, max: row.z1max },
    z2: { min: row.z2min, max: row.z2max },
    z3: { min: row.z3min, max: row.z3max },
    z4: { min: row.z4min, max: row.z4max },
    z5: { min: row.z5min, max: row.z5max }
  };
};

// ── Analysis ──────────────────────────────────────────────────────────────────
export const upsertAnalysis = (analysis: any): void => {
  db.prepare(`
    INSERT OR REPLACE INTO analysis
      (id, totalCyclingRides, maxRecordedHr, estimatedMaxHr, estimatedLthr,
       averageRideDurationMinutes,
       z1min, z1max, z2min, z2max, z3min, z3max, z4min, z4max, z5min, z5max,
       updatedAt)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    analysis.totalCyclingRides,
    analysis.maxRecordedHr,
    analysis.estimatedMaxHr,
    analysis.estimatedLthr,
    analysis.averageRideDurationMinutes,
    ...flattenZones(analysis.suggestedZones),
    new Date().toISOString()
  );
};

export const getStoredAnalysis = (): any | null => {
  const row = db.prepare('SELECT * FROM analysis WHERE id = 1').get() as any;
  if (!row) return null;
  return {
    totalCyclingRides: row.totalCyclingRides,
    maxRecordedHr: row.maxRecordedHr,
    estimatedMaxHr: row.estimatedMaxHr,
    estimatedLthr: row.estimatedLthr,
    averageRideDurationMinutes: row.averageRideDurationMinutes,
    suggestedZones: zonesFromRow(row),
    updatedAt: row.updatedAt
  };
};

// ── Profile ───────────────────────────────────────────────────────────────────
export const upsertProfileDB = (profile: any): void => {
  db.prepare(`
    INSERT OR REPLACE INTO profile
      (id, maxHr, lthr,
       z1min, z1max, z2min, z2max, z3min, z3max, z4min, z4max, z5min, z5max,
       hasCustomOverrides, lastUpdated)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    profile.maxHr,
    profile.lthr,
    ...flattenZones(profile.zones),
    profile.hasCustomOverrides ? 1 : 0,
    new Date().toISOString()
  );
};

export const getStoredProfile = (): any | null => {
  const row = db.prepare('SELECT * FROM profile WHERE id = 1').get() as any;
  if (!row) return null;
  return {
    maxHr: row.maxHr,
    lthr: row.lthr,
    zones: zonesFromRow(row),
    hasCustomOverrides: !!row.hasCustomOverrides,
    lastUpdated: row.lastUpdated
  };
};

// ── Settings ──────────────────────────────────────────────────────────────────
export const getSetting = (key: string): string | null => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
};

export const setSetting = (key: string, value: string): void => {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
};

// ── Recommendation ────────────────────────────────────────────────────────────
export interface WorkoutStep {
  stepType: 'WarmUp' | 'Run' | 'Recovery' | 'Cooldown';
  durationSec: number;
  zone: 'z1' | 'z2' | 'z3' | 'z4' | 'z5';
  label: string;
}

export interface WorkoutStructure {
  totalMinutes: number;
  steps: WorkoutStep[];
}

export interface PlanEntry {
  date: string;
  type: string;
  reason: string;
  status: 'planned' | 'completed' | 'skipped' | 'auto-skipped';
  structure?: WorkoutStructure | null;
  executionScore?: number | null;   // 0-100, AI-generated quality score
  executionNote?: string | null;    // 1-sentence AI explanation of the score
}

export const upsertRecommendation = (rec: {
  workoutType: string;
  reason: string;
  priority: string;
  weeklyPlan: PlanEntry[];
  nextWeekOverview: object;
  loadAssessment: object;
}): void => {
  db.prepare(`
    INSERT OR REPLACE INTO recommendation
      (id, workoutType, reason, priority, weeklyPlan, nextWeekOverview, loadAssessment, generatedAt)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    rec.workoutType,
    rec.reason,
    rec.priority,
    JSON.stringify(rec.weeklyPlan),
    JSON.stringify(rec.nextWeekOverview),
    JSON.stringify(rec.loadAssessment),
    new Date().toISOString()
  );
};

export const getStoredRecommendation = (): any | null => {
  const row = db.prepare('SELECT * FROM recommendation WHERE id = 1').get() as any;
  if (!row) return null;
  try {
    return {
      workoutType:      row.workoutType,
      reason:           row.reason,
      priority:         row.priority,
      weeklyPlan:       JSON.parse(row.weeklyPlan       || '[]'),
      nextWeekOverview: JSON.parse(row.nextWeekOverview || 'null'),
      loadAssessment:   JSON.parse(row.loadAssessment   || 'null'),
      generatedAt:      row.generatedAt
    };
  } catch (e) {
    logger.warn('[DB] getStoredRecommendation: JSON parse failed — returning null ' + JSON.stringify(e));
    return null;
  }
};

/** Update the status of a single plan entry identified by date. Returns true if found. */
export const updatePlanEntryStatus = (
  date: string,
  status: 'completed' | 'skipped' | 'auto-skipped'
): boolean => {
  const row = db.prepare('SELECT weeklyPlan FROM recommendation WHERE id = 1').get() as any;
  if (!row) return false;

  let plan: PlanEntry[];
  try {
    plan = JSON.parse(row.weeklyPlan || '[]');
  } catch {
    logger.warn('[DB] updatePlanEntryStatus: weeklyPlan JSON parse failed');
    return false;
  }
  const idx = plan.findIndex(e => e.date === date);
  if (idx === -1) return false;

  plan[idx].status = status;
  db.prepare('UPDATE recommendation SET weeklyPlan = ? WHERE id = 1').run(JSON.stringify(plan));
  return true;
};

/** Swap the dates of two plan entries. Used for "move to today" reschedule.
 *  Keeps all other entry properties (type, reason, structure) intact. */
export const swapPlanEntryDates = (date1: string, date2: string): boolean => {
  const row = db.prepare('SELECT weeklyPlan FROM recommendation WHERE id = 1').get() as any;
  if (!row) return false;

  let plan: PlanEntry[];
  try {
    plan = JSON.parse(row.weeklyPlan || '[]');
  } catch {
    logger.warn('[DB] swapPlanEntryDates: weeklyPlan JSON parse failed');
    return false;
  }
  const idx1 = plan.findIndex(e => e.date === date1);
  const idx2 = plan.findIndex(e => e.date === date2);
  if (idx1 === -1 || idx2 === -1) return false;

  // Swap only the date fields; everything else (type, reason, structure, status) stays
  plan[idx1].date = date2;
  plan[idx2].date = date1;

  // Re-sort chronologically so the array stays in order
  plan.sort((a, b) => a.date.localeCompare(b.date));

  db.prepare('UPDATE recommendation SET weeklyPlan = ? WHERE id = 1').run(JSON.stringify(plan));
  return true;
};
