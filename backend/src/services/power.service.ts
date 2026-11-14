import { getSetting, setSetting, deleteSetting, getStoredActivities } from './database.service';

/**
 * Power-meter support: FTP and the figures derived from it.
 *
 * Power is SUPPLEMENTARY to heart rate in Velomate, not a replacement. The athlete rides
 * several bikes and only some have a power meter, so every workout, zone and load figure
 * keeps working on heart rate alone. Power is extra evidence about what was actually ridden.
 *
 * FTP lives in `settings`, not in the `profile` row: that row is written with INSERT OR
 * REPLACE by several callers that know nothing about power, and any of them would wipe it.
 *
 *   ftp_watts   the FTP in use (absent = not set)
 *   ftp_source  'garmin' (follows Garmin's own FTP on every sync) | 'manual' (athlete typed it)
 *   garmin_ftp  the last FTP Garmin reported, kept so the form can offer it even when the
 *               athlete has overridden it
 */

export type FtpSource = 'garmin' | 'manual';

export const FTP_MIN = 50;
export const FTP_MAX = 600;

/** Share of a 20-minute best that approximates FTP (the standard 20-minute test). */
export const FTP_FROM_20MIN = 0.95;

/** Window for the best-20-minutes figure, same as the HR analysis window. */
const BEST_POWER_DAYS = 90;

export const isSaneFtp = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= FTP_MIN && v <= FTP_MAX;

const readInt = (key: string): number | null => {
  const n = Number(getSetting(key));
  return isSaneFtp(n) ? Math.round(n) : null;
};

export const getFtp = (): { ftp: number | null; source: FtpSource | null } => {
  const ftp = readInt('ftp_watts');
  const raw = getSetting('ftp_source');
  return { ftp, source: ftp == null ? null : raw === 'manual' ? 'manual' : 'garmin' };
};

/**
 * What the athlete entered in the training profile. A value equal to Garmin's keeps following
 * Garmin (so a later Garmin update still arrives); a cleared field removes the override, and
 * Garmin's FTP, when there is one, fills it again on the next sync.
 */
export const setFtpFromAthlete = (value: number | null): void => {
  if (value == null) {
    deleteSetting('ftp_watts');
    deleteSetting('ftp_source');
    const garmin = readInt('garmin_ftp');
    if (garmin != null) {
      setSetting('ftp_watts', String(garmin));
      setSetting('ftp_source', 'garmin');
    }
    return;
  }
  const rounded = Math.round(value);
  setSetting('ftp_watts', String(rounded));
  setSetting('ftp_source', rounded === readInt('garmin_ftp') ? 'garmin' : 'manual');
};

/** Called on every Garmin sync. Never overrides an FTP the athlete set themselves. */
export const applyGarminFtp = (garminFtp: number | null): void => {
  if (garminFtp == null) return;
  setSetting('garmin_ftp', String(garminFtp));
  if (getSetting('ftp_source') !== 'manual') {
    setSetting('ftp_watts', String(garminFtp));
    setSetting('ftp_source', 'garmin');
  }
};

/** Highest 20-minute average power over the last 90 days, with the ride it came from. */
export const getBest20MinPower = (): { watts: number; date: string } | null => {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - BEST_POWER_DAYS);
  let best: { watts: number; date: string } | null = null;
  for (const a of getStoredActivities()) {
    if (!a.startTime || new Date(a.startTime) < cutoff) continue;
    const w = a.max20MinPower;
    if (typeof w === 'number' && w > 0 && (!best || w > best.watts)) {
      best = { watts: w, date: a.startTime.slice(0, 10) };
    }
  }
  return best;
};

/** Whether any stored ride in the last 90 days carries power at all. */
export const hasRecentPowerRides = (): boolean => {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - BEST_POWER_DAYS);
  return getStoredActivities().some(a =>
    a.startTime && new Date(a.startTime) >= cutoff && (a.averagePower ?? 0) > 0
  );
};

/** Intensity factor (NP / FTP), two decimals, or null without both. */
export const intensityFactor = (normPower: number | null | undefined, ftp: number | null): number | null =>
  normPower && ftp ? Math.round((normPower / ftp) * 100) / 100 : null;

/** Everything the frontend needs about power, attached to every profile response. */
export const getPowerProfile = () => {
  const { ftp, source } = getFtp();
  const best = getBest20MinPower();
  return {
    ftp,
    ftpSource:     source,
    garminFtp:     readInt('garmin_ftp'),
    best20Power:   best?.watts ?? null,
    best20Date:    best?.date ?? null,
    estimatedFtp:  best ? Math.round(best.watts * FTP_FROM_20MIN) : null,
  };
};

/**
 * Finds Garmin's FTP in an arbitrary payload. The exact location differs between endpoints
 * (user settings vs. the biometric service, object vs. array), and it is not yet confirmed
 * against a real account, so this looks for the field by name rather than by path.
 */
export const findFtpInPayload = (payload: unknown, depth = 0): number | null => {
  if (!payload || typeof payload !== 'object' || depth > 4) return null;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const hit = findFtpInPayload(item, depth + 1);
      if (hit != null) return hit;
    }
    return null;
  }
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (/^(functionalThresholdPower|ftp)$/i.test(k) && isSaneFtp(v)) return Math.round(v);
  }
  for (const v of Object.values(payload as Record<string, unknown>)) {
    if (v && typeof v === 'object') {
      const hit = findFtpInPayload(v, depth + 1);
      if (hit != null) return hit;
    }
  }
  return null;
};
