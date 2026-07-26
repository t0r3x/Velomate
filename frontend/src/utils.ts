import type { PlanEntry, PlanEntryStatus } from './types'

/**
 * Returns today's date as YYYY-MM-DD using the browser's local timezone.
 * 'sv-SE' (Swedish) locale is a standard JS idiom for ISO date format.
 */
export const isoDate = (d = new Date()): string =>
  d.toLocaleDateString('sv-SE')

/**
 * Build a real 7-day display window starting `startOffset` days from today, filling
 * any day the backend hasn't planned yet with a placeholder entry — never fabricate
 * a real AI-planned rest day for a date the backend simply hasn't covered.
 */
export const buildWeekWindow = (plan: PlanEntry[], startOffset = 0): PlanEntry[] => {
  const todayStr = isoDate()
  const today = new Date(todayStr + 'T12:00:00')
  const planMap = new Map(plan.map(e => [e.date, e]))

  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today)
    d.setDate(today.getDate() + startOffset + i)
    const dateStr = isoDate(d)
    return planMap.get(dateStr) ?? {
      date:              dateStr,
      type:              'Rest',
      reason:            '',
      status:            'planned' as PlanEntryStatus,
      isPlaceholder:     true,
      isPastPlaceholder: dateStr < todayStr,
    }
  })
}

/**
 * Human-readable note when part of a displayed window has no backend plan coverage.
 * Only counts FUTURE gaps — refreshing regenerates forward from today, so it can genuinely
 * close those. Past gaps (before today, e.g. a fixed calendar week's early days before the
 * plan's history began) can never be filled by a refresh, so they're deliberately excluded
 * here — WeekDayCell renders them as quiet "No data", not as an actionable warning.
 */
export const describeCoverageGaps = (entries: PlanEntry[]): string => {
  const gaps = entries.filter(e => e.isPlaceholder && !e.isPastPlaceholder).length
  if (gaps === 0) return ''
  return gaps === 1
    ? 'The AI plan doesn’t cover 1 of these days yet — refresh to extend it.'
    : `The AI plan doesn’t cover ${gaps} of these days yet — refresh to extend it.`
}

/**
 * Convert raw Garmin perceived exertion (0–100) to Borg 1–10 RPE.
 */
export const toRpe = (raw: number): number =>
  Math.max(1, Math.min(10, Math.round(raw / 10)))

/**
 * Convert raw Garmin post-ride feeling (0–100) to 1–5 feeling scale.
 * 1 = Exhausted · 2 = Tired · 3 = Normal · 4 = Good · 5 = Strong.
 */
export const toFeeling = (raw: number): number =>
  Math.max(1, Math.min(5, Math.round(raw / 25) + 1))

/** Workout type → icon class */
export const workoutTypeIcon: Record<string, string> = {
  Sprint:    'fa-bolt',
  VO2Max:    'fa-lungs',
  Threshold: 'fa-fire-flame-curved',
  Tempo:     'fa-gauge-high',
  LongRide:  'fa-road',
  Rest:      'fa-bed'
}

/** Workout type → display label */
export const workoutTypeLabel: Record<string, string> = {
  Sprint:    'Sprint',
  VO2Max:    'VO2 Max',
  Threshold: 'Threshold',
  Tempo:     'Tempo',
  LongRide:  'Long Ride',
  Rest:      'Rest'
}

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Garmin activity type → display label */
export const ACTIVITY_TYPE_LABELS: Record<string, string> = {
  cycling:          'Cycling',
  road_biking:      'Road Cycling',
  mountain_biking:  'Mountain Biking',
  gravel_cycling:   'Gravel Cycling',
  indoor_cycling:   'Indoor Cycling',
  virtual_ride:     'Virtual Ride',
  e_bike_mountain:  'E-Bike MTB',
  e_bike_fitness:   'E-Bike',
  bmx:              'BMX',
  cyclocross:       'Cyclocross',
  track_cycling:    'Track Cycling'
}
