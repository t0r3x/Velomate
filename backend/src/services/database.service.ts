import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// ── Setup ─────────────────────────────────────────────────────────────────────
const dataDir = path.join(__dirname, '../../data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// Use velomate.db; fall back to unbound.db for existing installs that haven't renamed yet.
const newDbPath    = path.join(dataDir, 'velomate.db');
const legacyDbPath = path.join(dataDir, 'unbound.db');
const resolvedDbPath = fs.existsSync(newDbPath) || !fs.existsSync(legacyDbPath)
  ? newDbPath
  : legacyDbPath;
const db = new Database(resolvedDbPath);

// WAL mode — better concurrent read performance
db.pragma('journal_mode = WAL');

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
    fetchedAt     TEXT    DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS analysis (
    id                        INTEGER PRIMARY KEY CHECK (id = 1),
    totalCyclingRides         INTEGER,
    maxRecordedHr             INTEGER,
    estimatedMaxHr            INTEGER,
    estimatedLthr             INTEGER,
    averageRideDurationMinutes INTEGER,
    suggestedZones            TEXT,
    updatedAt                 TEXT    DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS profile (
    id               INTEGER PRIMARY KEY CHECK (id = 1),
    maxHr            INTEGER,
    lthr             INTEGER,
    zones            TEXT,
    hasCustomOverrides INTEGER DEFAULT 0,
    lastUpdated      TEXT    DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS devices (
    deviceId    TEXT PRIMARY KEY,
    displayName TEXT,
    activityTypes TEXT,
    rawData     TEXT,
    fetchedAt   TEXT DEFAULT CURRENT_TIMESTAMP
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

// ── Migrations (safe — ignore if column already exists) ───────────────────────
const _migrations: Array<[string, string]> = [
  [`ALTER TABLE activities ADD COLUMN timeInZones TEXT DEFAULT NULL`,         '[DB] Migration: added timeInZones column'],
  [`ALTER TABLE activities ADD COLUMN perceivedExertion INTEGER DEFAULT NULL`, '[DB] Migration: added perceivedExertion column'],
  [`ALTER TABLE activities ADD COLUMN feelingAfterExercise INTEGER DEFAULT NULL`, '[DB] Migration: added feelingAfterExercise column'],
];
for (const [sql, msg] of _migrations) {
  try { db.exec(sql); console.log(msg); } catch { /* column already exists */ }
}

// ── Activities ────────────────────────────────────────────────────────────────
// UPSERT: on conflict, update all fields EXCEPT perceivedExertion/feelingAfterExercise —
// those are fetched via the detail endpoint separately and must not be overwritten by the
// bulk list sync (which never includes them).
const stmtUpsertActivity = db.prepare(`
  INSERT INTO activities
    (activityId, name, type, startTime, distanceKm, durationMinutes,
     averageHr, maxHr, averagePower, maxPower, timeInZones,
     perceivedExertion, feelingAfterExercise, fetchedAt)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
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
    timeInZones         = excluded.timeInZones,
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
      a.timeInZones != null ? JSON.stringify(a.timeInZones) : null,
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
  return db.prepare('SELECT * FROM activities ORDER BY startTime DESC').all();
};

export const getActivityCount = (): number => {
  const row = db.prepare('SELECT COUNT(*) as count FROM activities').get() as { count: number };
  return row.count;
};

// ── Analysis ──────────────────────────────────────────────────────────────────
export const upsertAnalysis = (analysis: any): void => {
  db.prepare(`
    INSERT OR REPLACE INTO analysis
      (id, totalCyclingRides, maxRecordedHr, estimatedMaxHr, estimatedLthr,
       averageRideDurationMinutes, suggestedZones, updatedAt)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    analysis.totalCyclingRides,
    analysis.maxRecordedHr,
    analysis.estimatedMaxHr,
    analysis.estimatedLthr,
    analysis.averageRideDurationMinutes,
    JSON.stringify(analysis.suggestedZones),
    new Date().toISOString()
  );
};

export const getStoredAnalysis = (): any | null => {
  const row = db.prepare('SELECT * FROM analysis WHERE id = 1').get() as any;
  if (!row) return null;
  let suggestedZones = null;
  try { suggestedZones = JSON.parse(row.suggestedZones || 'null'); } catch {
    console.warn('[DB] getStoredAnalysis: failed to parse suggestedZones');
  }
  return {
    totalCyclingRides: row.totalCyclingRides,
    maxRecordedHr: row.maxRecordedHr,
    estimatedMaxHr: row.estimatedMaxHr,
    estimatedLthr: row.estimatedLthr,
    averageRideDurationMinutes: row.averageRideDurationMinutes,
    suggestedZones,
    updatedAt: row.updatedAt
  };
};

// ── Profile ───────────────────────────────────────────────────────────────────
export const upsertProfileDB = (profile: any): void => {
  db.prepare(`
    INSERT OR REPLACE INTO profile
      (id, maxHr, lthr, zones, hasCustomOverrides, lastUpdated)
    VALUES (1, ?, ?, ?, ?, ?)
  `).run(
    profile.maxHr,
    profile.lthr,
    JSON.stringify(profile.zones),
    profile.hasCustomOverrides ? 1 : 0,
    new Date().toISOString()
  );
};

export const getStoredProfile = (): any | null => {
  const row = db.prepare('SELECT * FROM profile WHERE id = 1').get() as any;
  if (!row) return null;
  let zones = null;
  try { zones = JSON.parse(row.zones || 'null'); } catch {
    console.warn('[DB] getStoredProfile: failed to parse zones');
  }
  return {
    maxHr: row.maxHr,
    lthr: row.lthr,
    zones,
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
    console.warn('[DB] getStoredRecommendation: JSON parse failed — returning null', e);
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
    console.warn('[DB] updatePlanEntryStatus: weeklyPlan JSON parse failed');
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
    console.warn('[DB] swapPlanEntryDates: weeklyPlan JSON parse failed');
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
