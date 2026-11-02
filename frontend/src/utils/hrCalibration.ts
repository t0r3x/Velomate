import type { Activity } from '@/types'

/**
 * The "are the heart rate zones set too low?" rules, shared by the app header and the ride rows
 * so the two never disagree. Same thresholds as buildHrCalibrationLines() in the backend, so the
 * UI and the coach agree as well: change them together.
 */
export const HR_PEAK_MARGIN = 2
export const HR_LTHR_MIN_RIDE_MIN = 60
export const HR_CHECK_DAYS = 90

/** LTHR is about the highest heart rate you can hold for an hour, so a longer ride above it says LTHR is too low. */
export const averagedAboveLthr = (a: Activity, lthr: number): boolean =>
  lthr > 0 && (a.durationMinutes ?? 0) >= HR_LTHR_MIN_RIDE_MIN && (a.averageHr ?? 0) > lthr

export const peakAboveMax = (a: Activity, maxHr: number): boolean =>
  maxHr > 0 && (a.maxHr ?? 0) > maxHr + HR_PEAK_MARGIN

/** Rides inside the check window, newest first. */
export const recentRides = (activities: Activity[]): Activity[] => {
  const cutoff = Date.now() - HR_CHECK_DAYS * 86_400_000
  return activities
    .filter(a => new Date(a.startTime).getTime() >= cutoff)
    .sort((a, b) => b.startTime.localeCompare(a.startTime))
}

/** "Sat 12 Sept · 107 min · avg 161 bpm": enough to find the ride in the list. */
export const rideSummary = (a: Activity, hr: 'avg' | 'max'): string => {
  const day = new Date(a.startTime).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
  return `${day} · ${a.durationMinutes} min · ${hr} ${hr === 'avg' ? a.averageHr : a.maxHr} bpm`
}
