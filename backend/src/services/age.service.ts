import { getSetting, setSetting, deleteSetting } from './database.service';
import { localDate } from '../utils';

/**
 * The athlete's age, used by the coach for recovery between hard sessions (see the AGE bullet
 * in prompts/shared/calibration.md). It never sets heart rate zones: 220-minus-age is far
 * worse than the max HR the athlete's own rides show.
 *
 * Stored as a birth date, not an age, so it does not go stale. Same pattern as FTP
 * (power.service.ts): it follows Garmin's birth date until the athlete types their own age.
 *
 *   birth_date         the birth date in use (YYYY-MM-DD; absent = not set)
 *   birth_date_source  'garmin' (follows Garmin on every sync) | 'manual' (athlete typed an age)
 *   garmin_birth_date  the last birth date Garmin reported, kept so the form can offer it
 *
 * A typed age is stored as 1 January of (this year - age): it reads as that age for the rest
 * of the year and rolls over on New Year. A year out at most, which changes nothing in coaching.
 */

export type AgeSource = 'garmin' | 'manual';

export const AGE_MIN = 10;
export const AGE_MAX = 100;

export const isSaneAge = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= AGE_MIN && v <= AGE_MAX;

const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Whole years between a birth date and today (local date). */
export const ageFromBirthDate = (birthDate: string, today = localDate()): number => {
  const [by, bm, bd] = birthDate.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
};

const readBirthDate = (key: string): string | null => {
  const v = getSetting(key);
  return isDate(v) && isSaneAge(ageFromBirthDate(v)) ? v : null;
};

export const getAge = (): { age: number | null; source: AgeSource | null } => {
  const birth = readBirthDate('birth_date');
  if (!birth) return { age: null, source: null };
  return { age: ageFromBirthDate(birth), source: getSetting('birth_date_source') === 'manual' ? 'manual' : 'garmin' };
};

/**
 * What the athlete entered. An age equal to Garmin's keeps following Garmin; an empty field
 * removes the override, and Garmin's birth date, when there is one, fills it again.
 */
export const setAgeFromAthlete = (age: number | null): void => {
  const garmin = readBirthDate('garmin_birth_date');
  if (age == null || (garmin && ageFromBirthDate(garmin) === age)) {
    deleteSetting('birth_date');
    deleteSetting('birth_date_source');
    if (garmin) {
      setSetting('birth_date', garmin);
      setSetting('birth_date_source', 'garmin');
    }
    return;
  }
  setSetting('birth_date', `${Number(localDate().slice(0, 4)) - age}-01-01`);
  setSetting('birth_date_source', 'manual');
};

/** Called on every Garmin sync. Never overrides an age the athlete typed themselves. */
export const applyGarminBirthDate = (raw: unknown): void => {
  const date = typeof raw === 'string' ? raw.slice(0, 10) : null;
  if (!isDate(date) || !isSaneAge(ageFromBirthDate(date))) return;
  setSetting('garmin_birth_date', date);
  if (getSetting('birth_date_source') !== 'manual') {
    setSetting('birth_date', date);
    setSetting('birth_date_source', 'garmin');
  }
};

/** Attached to every profile response. */
export const getAgeProfile = () => {
  const { age, source } = getAge();
  const garmin = readBirthDate('garmin_birth_date');
  return { age, ageSource: source, garminAge: garmin ? ageFromBirthDate(garmin) : null };
};
