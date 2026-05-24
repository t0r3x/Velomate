import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// ── Setup ─────────────────────────────────────────────────────────────────────
const dataDir = path.join(__dirname, '../../data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'innerjoin.db'));

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
try {
  db.exec(`ALTER TABLE activities ADD COLUMN timeInZones TEXT DEFAULT NULL`);
  console.log('[DB] Migration: added timeInZones column to activities');
} catch { /* column already exists */ }

// ── Activities ────────────────────────────────────────────────────────────────
const stmtUpsertActivity = db.prepare(`
  INSERT OR REPLACE INTO activities
    (activityId, name, type, startTime, distanceKm, durationMinutes,
     averageHr, maxHr, averagePower, maxPower, timeInZones, fetchedAt)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
`);

const upsertManyActivities = db.transaction((activities: any[]) => {
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
      a.timeInZones != null ? JSON.stringify(a.timeInZones) : null
    );
  }
});

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
    VALUES (1, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    analysis.totalCyclingRides,
    analysis.maxRecordedHr,
    analysis.estimatedMaxHr,
    analysis.estimatedLthr,
    analysis.averageRideDurationMinutes,
    JSON.stringify(analysis.suggestedZones)
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
    suggestedZones: JSON.parse(row.suggestedZones || 'null'),
    updatedAt: row.updatedAt
  };
};

// ── Profile ───────────────────────────────────────────────────────────────────
export const upsertProfileDB = (profile: any): void => {
  db.prepare(`
    INSERT OR REPLACE INTO profile
      (id, maxHr, lthr, zones, hasCustomOverrides, lastUpdated)
    VALUES (1, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    profile.maxHr,
    profile.lthr,
    JSON.stringify(profile.zones),
    profile.hasCustomOverrides ? 1 : 0
  );
};

export const getStoredProfile = (): any | null => {
  const row = db.prepare('SELECT * FROM profile WHERE id = 1').get() as any;
  if (!row) return null;
  return {
    maxHr: row.maxHr,
    lthr: row.lthr,
    zones: JSON.parse(row.zones || 'null'),
    hasCustomOverrides: !!row.hasCustomOverrides,
    lastUpdated: row.lastUpdated
  };
};

// ── Devices ───────────────────────────────────────────────────────────────────
const stmtUpsertDevice = db.prepare(`
  INSERT OR REPLACE INTO devices (deviceId, displayName, activityTypes, rawData, fetchedAt)
  VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
`);

const upsertManyDevices = db.transaction((devices: any[]) => {
  for (const d of devices) {
    const deviceId = String(d.deviceId || d.unitId || '');
    const displayName = d.productDisplayName || d.deviceMetaDataDTO?.deviceProductDescription || '';
    const activityTypes = JSON.stringify(d.activityTypes || []);
    stmtUpsertDevice.run(deviceId, displayName, activityTypes, JSON.stringify(d));
  }
});

export const upsertDevices = (devices: any[]): void => {
  upsertManyDevices(devices);
};

export const getStoredDevices = (): any[] => {
  const rows = db.prepare('SELECT rawData FROM devices ORDER BY displayName').all() as any[];
  return rows.map(r => JSON.parse(r.rawData));
};

export const hasStoredDevices = (): boolean => {
  const row = db.prepare('SELECT COUNT(*) as count FROM devices').get() as { count: number };
  return row.count > 0;
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
  status: 'planned' | 'completed' | 'completed-partial' | 'completed-mismatch' | 'skipped' | 'auto-skipped';
  structure?: WorkoutStructure | null;
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
  return {
    workoutType:      row.workoutType,
    reason:           row.reason,
    priority:         row.priority,
    weeklyPlan:       JSON.parse(row.weeklyPlan   || '[]'),
    nextWeekOverview: JSON.parse(row.nextWeekOverview || 'null'),
    loadAssessment:   JSON.parse(row.loadAssessment  || 'null'),
    generatedAt:      row.generatedAt
  };
};

/** Update the status of a single plan entry identified by date. Returns true if found. */
export const updatePlanEntryStatus = (
  date: string,
  status: 'completed' | 'completed-partial' | 'completed-mismatch' | 'skipped' | 'auto-skipped'
): boolean => {
  const row = db.prepare('SELECT weeklyPlan FROM recommendation WHERE id = 1').get() as any;
  if (!row) return false;

  const plan: PlanEntry[] = JSON.parse(row.weeklyPlan || '[]');
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

  const plan: PlanEntry[] = JSON.parse(row.weeklyPlan || '[]');
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
