import type { Activity } from '@/types'
import { isoDate } from '@/utils'

/**
 * Training load, fitness, fatigue and form, computed from the rides already in the store.
 *
 * This is the athlete's own view of their trend, deliberately independent of the AI coach:
 * plain arithmetic over the ride history, so what the chart shows never depends on what a
 * model decided to say.
 *
 * Load per ride is Edwards' zone-weighted TRIMP: minutes in zone N count N times (Z1 = 1 …
 * Z5 = 5). It uses Garmin's own zone split (the timeInZones seconds), which is based on
 * Garmin's max HR, so a Velomate HR profile that is set too low does not inflate it.
 *
 * Fitness and fatigue are the usual exponentially weighted averages of daily load, over 42
 * and 7 days (the Banister / TrainingPeaks model). Form is yesterday's fitness minus
 * yesterday's fatigue: how fresh you start today, before today's ride is counted.
 */

export const FITNESS_DAYS = 42
export const FATIGUE_DAYS = 7
/** Ride frequency is measured over the last four weeks. */
const RIDE_RATE_DAYS = 28

export interface DayPoint {
  date: string        // YYYY-MM-DD
  load: number        // TRIMP ridden that day
  rides: number
  fitness: number
  fatigue: number
  form: number
  ridesPerWeek: number  // trailing 4 weeks (or what history there is), for the low-volume form words
}

export interface WeekPoint {
  weekStart: string   // Monday, YYYY-MM-DD
  zoneMinutes: number[] // [z1..z5]
  totalMinutes: number
  rides: number
}

/** The ride's minutes per zone: Garmin's split when present, else all of it in one estimated zone. */
export function zoneMinutes(a: Activity, maxHr: number): number[] {
  const z = a.timeInZones
  if (Array.isArray(z) && z.length >= 5) return z.slice(0, 5).map(s => (s ?? 0) / 60)

  // No zone data: Garmin's default zones are 50/60/70/80/90 % of max HR, so place the whole
  // ride in the zone its average HR falls in. Rough, but better than dropping the ride.
  const minutes = a.durationMinutes ?? 0
  const out = [0, 0, 0, 0, 0]
  if (!minutes) return out
  const ratio = maxHr > 0 && a.averageHr ? a.averageHr / maxHr : 0.65
  const zone = ratio < 0.6 ? 0 : ratio < 0.7 ? 1 : ratio < 0.8 ? 2 : ratio < 0.9 ? 3 : 4
  out[zone] = minutes
  return out
}

export function rideLoad(a: Activity, maxHr: number): number {
  return zoneMinutes(a, maxHr).reduce((sum, m, i) => sum + m * (i + 1), 0)
}

const addDays = (date: string, n: number): string => {
  const d = new Date(date + 'T12:00:00')
  d.setDate(d.getDate() + n)
  return isoDate(d)
}

const mondayOf = (date: string): string => {
  const d = new Date(date + 'T12:00:00')
  const offset = (d.getDay() + 6) % 7   // Monday = 0
  d.setDate(d.getDate() - offset)
  return isoDate(d)
}

const rideDate = (a: Activity): string => (a.startTime ?? '').slice(0, 10)

/**
 * One point per calendar day from the first stored ride to today, rest days included —
 * fitness and fatigue decay on days without a ride, and that decay is half the picture.
 */
export function buildDailySeries(activities: Activity[], maxHr: number, today = isoDate()): DayPoint[] {
  const rides = activities.filter(a => rideDate(a))
  if (rides.length === 0) return []

  const loadByDate = new Map<string, { load: number; rides: number }>()
  for (const a of rides) {
    const d = rideDate(a)
    const cur = loadByDate.get(d) ?? { load: 0, rides: 0 }
    cur.load += rideLoad(a, maxHr)
    cur.rides += 1
    loadByDate.set(d, cur)
  }

  const first = [...loadByDate.keys()].sort()[0]
  const points: DayPoint[] = []
  let fitness = 0
  let fatigue = 0
  const window: number[] = []   // rides per day, last RIDE_RATE_DAYS days
  for (let d = first; d <= today; d = addDays(d, 1)) {
    const day = loadByDate.get(d) ?? { load: 0, rides: 0 }
    const form = fitness - fatigue   // yesterday's values: how fresh you start this day
    fitness += (day.load - fitness) / FITNESS_DAYS
    fatigue += (day.load - fatigue) / FATIGUE_DAYS
    window.push(day.rides)
    if (window.length > RIDE_RATE_DAYS) window.shift()
    const ridesPerWeek = (window.reduce((a, b) => a + b, 0) / window.length) * 7
    points.push({ date: d, load: Math.round(day.load), rides: day.rides, fitness, fatigue, form, ridesPerWeek })
  }
  return points
}

/** Minutes per zone per Monday-starting week, for every week from `from` to today (empty weeks included). */
export function buildWeeklyZones(activities: Activity[], maxHr: number, from: string, today = isoDate()): WeekPoint[] {
  const weeks = new Map<string, WeekPoint>()
  for (let w = mondayOf(from); w <= today; w = addDays(w, 7)) {
    weeks.set(w, { weekStart: w, zoneMinutes: [0, 0, 0, 0, 0], totalMinutes: 0, rides: 0 })
  }
  for (const a of activities) {
    const d = rideDate(a)
    if (!d || d < from || d > today) continue
    const week = weeks.get(mondayOf(d))
    if (!week) continue
    zoneMinutes(a, maxHr).forEach((m, i) => { week.zoneMinutes[i] += m })
    week.totalMinutes += a.durationMinutes ?? 0
    week.rides += 1
  }
  return [...weeks.values()]
}

/**
 * Form relative to fitness, as intervals.icu does: a raw form number means little without
 * knowing the fitness it is measured against, while a percentage reads the same for a
 * beginner and a racer. Bands follow intervals.icu's.
 */
/**
 * The form bands, highest first: form as a percentage of fitness, above `min`. One list feeds
 * both the label and the explanation panel, so the help text can never drift from the logic.
 */
export const FORM_BANDS: { label: string; min: number; range: string; meaning: string }[] = [
  { label: 'Transition',   min: 25,        range: 'above +25%',     meaning: 'Very rested. Good before an event, but fitness is fading if it lasts.' },
  { label: 'Fresh',        min: 5,         range: '+5% to +25%',    meaning: 'Rested and ready for a hard session.' },
  { label: 'Neutral',      min: -10,       range: '-10% to +5%',    meaning: 'Balanced: training and recovery roughly even.' },
  { label: 'Building',     min: -30,       range: '-30% to -10%',   meaning: 'Carrying training fatigue. The productive zone for building fitness.' },
  { label: 'Overreaching', min: -Infinity, range: 'below -30%',     meaning: 'Fatigue well above fitness. Recovery comes first.' },
]

/**
 * At two rides a week or fewer the two outer bands overstate things. Fitness stays low because
 * the weekly load is spread over six weeks, so a single hard ride lifts fatigue far above it for
 * a few days ("Overreaching"), and a few rest days read as very fresh ("Transition"). Both are the
 * normal rhythm of a low-volume rider, so they get calmer words. The numbers do not change.
 */
export const LOW_VOLUME_RIDES_PER_WEEK = 2
export const LOW_VOLUME_LABELS: Record<string, { label: string; meaning: string }> = {
  Overreaching: {
    label: 'Recovering',
    meaning: 'A hard ride at low weekly volume lifts fatigue far above fitness for a few days. Normal at your rhythm; it passes within two or three days.',
  },
  Transition: {
    label: 'Rested',
    meaning: 'With few rides a week fitness stays low, so a few rest days quickly read as very fresh.',
  },
}

export function formLabel(form: number, fitness: number, ridesPerWeek = Infinity): string {
  if (fitness < 1) return 'No base yet'
  const pct = (form / fitness) * 100
  const band = FORM_BANDS.find(b => pct > b.min)?.label ?? 'Overreaching'
  return ridesPerWeek <= LOW_VOLUME_RIDES_PER_WEEK ? (LOW_VOLUME_LABELS[band]?.label ?? band) : band
}

export function formExplanation(label: string): string {
  return FORM_BANDS.find(b => b.label === label)?.meaning
    ?? Object.values(LOW_VOLUME_LABELS).find(l => l.label === label)?.meaning
    ?? 'Ride a few weeks to build a baseline.'
}

export { addDays, mondayOf }
