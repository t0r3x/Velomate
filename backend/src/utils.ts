/**
 * Shared utility helpers for the Velomate backend.
 * Import from here rather than duplicating these conversions across services.
 */

// ── App identity ──────────────────────────────────────────────────────────────

/** Canonical application name — used in Garmin workout names, banners, and log messages. */
export const APP_NAME = 'Velomate';

// ── Timezone ──────────────────────────────────────────────────────────────────

/**
 * Resolved timezone for date formatting.
 *
 * Resolution order:
 *   1. USER_TIMEZONE env var — override for misconfigured hosts
 *   2. System timezone — read via Intl.DateTimeFormat (respects OS/timedatectl config)
 *
 * On a Pi, set the system timezone once with:
 *   sudo timedatectl set-timezone Europe/Amsterdam
 * and this resolves automatically — no env var needed.
 *
 * Why this matters: without an explicit timezone, dates roll over at midnight UTC
 * instead of midnight local time on hosts running in UTC (Pi, VPS, Docker).
 */
export const USER_TZ: string =
  process.env.USER_TIMEZONE ??
  Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Returns a YYYY-MM-DD string for the given (or current) date, in the resolved timezone.
 *
 * The 'sv-SE' (Swedish) locale is a standard JS idiom for ISO date format —
 * Swedish locale just happens to format dates as YYYY-MM-DD.
 */
export const localDate = (d: Date = new Date()): string =>
  d.toLocaleDateString('sv-SE', { timeZone: USER_TZ });

// ── Garmin feedback conversions ───────────────────────────────────────────────

/**
 * Convert Garmin's raw perceived exertion (0–100 internal scale) to Borg 1–10 RPE.
 * Garmin fields: `directWorkoutRpe` (detail endpoint) or `perceivedExertion` (list).
 */
export const toRpe = (raw: number): number =>
  Math.max(1, Math.min(10, Math.round(raw / 10)));

/**
 * Convert Garmin's raw post-ride feeling (0–100 internal scale) to 1–5 feeling scale.
 * Garmin fields: `directWorkoutFeel` (detail endpoint) or `feelingAfterExercise` (list).
 * Scale: 1 = Exhausted · 2 = Tired · 3 = Normal · 4 = Good · 5 = Strong.
 */
export const toFeeling = (raw: number): number =>
  Math.max(1, Math.min(5, Math.round(raw / 25) + 1));
