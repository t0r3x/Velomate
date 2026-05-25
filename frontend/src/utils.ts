/**
 * Returns today's date as YYYY-MM-DD using the browser's local timezone.
 * 'sv-SE' (Swedish) locale is a standard JS idiom for ISO date format.
 */
export const isoDate = (d = new Date()): string =>
  d.toLocaleDateString('sv-SE')

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
