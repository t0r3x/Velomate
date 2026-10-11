import type { FitnessLevel, TrainingPhase } from './athletes';
import type { PlanEntry } from '../services/database.service';
import { localDate } from '../utils';

interface Range { min: number; max: number }

interface Criteria {
  sessionsPerWeek: Range;
  sprintPerWeek: Range;
  thresholdPerWeek: Range;
  vo2maxPerWeek: Range;
  tempoPerWeek: Range;
  longRidePerWeek: Range;
  restDaysPerWeek: Range;
  description: string;
}

// Base criteria per fitness level — assumes a normal build/base week.
// Taper and recovery phases are adjusted dynamically in evaluatePlan().
// Tempo is the permitted step up from an aerobic base (CALIBRATION_GUIDELINES), so even a
// beginner may get one; more than that is intensity a base phase does not call for.
const CRITERIA: Record<FitnessLevel, Criteria> = {
  beginner: {
    sessionsPerWeek:  { min: 2, max: 3 },
    sprintPerWeek:    { min: 0, max: 0 },
    thresholdPerWeek: { min: 0, max: 0 },
    vo2maxPerWeek:    { min: 0, max: 0 },
    tempoPerWeek:     { min: 0, max: 1 },
    longRidePerWeek:  { min: 0, max: 1 },
    restDaysPerWeek:  { min: 4, max: 5 },
    description: 'Easy aerobic work, at most one gentle Tempo. Build the habit first.',
  },
  recreational: {
    sessionsPerWeek:  { min: 3, max: 4 },
    sprintPerWeek:    { min: 0, max: 0 },
    thresholdPerWeek: { min: 0, max: 1 },
    vo2maxPerWeek:    { min: 0, max: 0 },
    tempoPerWeek:     { min: 0, max: 1 },
    longRidePerWeek:  { min: 1, max: 1 },
    restDaysPerWeek:  { min: 3, max: 4 },
    description: 'Mostly aerobic with optional light structure. One long ride per week.',
  },
  intermediate: {
    sessionsPerWeek:  { min: 4, max: 5 },
    sprintPerWeek:    { min: 0, max: 1 },
    thresholdPerWeek: { min: 1, max: 2 },
    vo2maxPerWeek:    { min: 0, max: 1 },
    tempoPerWeek:     { min: 0, max: 2 },
    longRidePerWeek:  { min: 1, max: 1 },
    restDaysPerWeek:  { min: 2, max: 3 },
    description: 'Z2 base + 1-2 hard sessions + 1 long ride. Progressive overload.',
  },
  advanced: {
    sessionsPerWeek:  { min: 5, max: 6 },
    sprintPerWeek:    { min: 1, max: 2 },
    thresholdPerWeek: { min: 1, max: 2 },
    vo2maxPerWeek:    { min: 0, max: 1 },
    tempoPerWeek:     { min: 0, max: 2 },
    longRidePerWeek:  { min: 1, max: 1 },
    restDaysPerWeek:  { min: 1, max: 2 },
    description: 'High variety. Regular Z4-Z5 work. 1-2 rest days only.',
  },
  pro: {
    // Realistic for a build/base week. Neuromuscular (Sprint) work is 1-2×/week max —
    // more than that causes cumulative fatigue without additional adaptation benefit.
    // Threshold: 1-2 hard blocks per week is the evidence-based sweet spot even for pros.
    // Rest: even WorldTour pros take 1 full rest day per week; 0 is a red flag.
    sessionsPerWeek:  { min: 5, max: 7 },
    sprintPerWeek:    { min: 1, max: 2 },
    thresholdPerWeek: { min: 1, max: 2 },
    vo2maxPerWeek:    { min: 0, max: 2 },
    tempoPerWeek:     { min: 0, max: 2 },
    longRidePerWeek:  { min: 1, max: 2 },
    restDaysPerWeek:  { min: 0, max: 2 },
    description: 'High-volume structured training. Race-specific periodization with regular Z4-Z5 sessions.',
  },
};

const QUALITY_TYPES = ['Tempo', 'Threshold', 'VO2Max', 'Sprint'];

type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  label: string;
  planned: number;
  expected: string;
  status: CheckStatus;
}

export interface EvaluationResult {
  criteria: Criteria;
  trainingPhase: TrainingPhase;
  checks: CheckResult[];
  score: number;
  verdict: 'excellent' | 'good' | 'acceptable' | 'poor';
  issues: string[];
}

/** What the evaluator needs to know about the athlete's recent history. */
export interface HistoryContext {
  /** Rides in the 21 days the athlete definition covers. */
  ridesIn21Days: number;
  /** analysis.averageRideDurationMinutes. */
  averageRideMinutes: number;
}

function inRange(value: number, range: Range): CheckStatus {
  if (value >= range.min && value <= range.max) return 'ok';
  const delta = value < range.min ? range.min - value : value - range.max;
  return delta <= 1 ? 'warn' : 'fail';
}

function rangeLabel(r: Range): string {
  return r.min === r.max ? String(r.min) : `${r.min}–${r.max}`;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/**
 * A "LongRide" only counts as a long ride when it is long for THIS athlete. The app has no
 * separate type for an easy endurance ride, so the model labels every steady Z2 ride
 * LongRide — a 35-min spin included. Counting those as long rides failed beginners for
 * riding three times a week.
 */
function isLongForAthlete(e: PlanEntry, avgRideMinutes: number): boolean {
  const minutes = e.structure?.totalMinutes ?? 0;
  return minutes >= Math.max(60, avgRideMinutes * 1.25);
}

export function evaluatePlan(
  level: FitnessLevel,
  weeklyPlan: PlanEntry[],
  trainingPhase: TrainingPhase = 'build',
  history?: HistoryContext
): EvaluationResult {
  let criteria: Criteria = { ...CRITERIA[level] };

  // Taper: reduced volume expected, more rest acceptable, intensity types still valid
  if (trainingPhase === 'taper') {
    criteria = {
      ...criteria,
      sessionsPerWeek:  { min: clamp(criteria.sessionsPerWeek.min - 2, 1, 7), max: criteria.sessionsPerWeek.max },
      restDaysPerWeek:  { min: criteria.restDaysPerWeek.min, max: clamp(criteria.restDaysPerWeek.max + 2, 2, 6) },
      description: criteria.description + ' (taper: volume reduced, intensity maintained)',
    };
  }

  // Recovery: minimal load, no hard sessions, lots of rest
  if (trainingPhase === 'recovery') {
    criteria = {
      ...criteria,
      sessionsPerWeek:  { min: 1, max: clamp(criteria.sessionsPerWeek.min, 1, 3) },
      sprintPerWeek:    { min: 0, max: 0 },
      thresholdPerWeek: { min: 0, max: 0 },
      vo2maxPerWeek:    { min: 0, max: 0 },
      tempoPerWeek:     { min: 0, max: 0 },
      restDaysPerWeek:  { min: clamp(criteria.restDaysPerWeek.max, 3, 6), max: 6 },
      description: criteria.description + ' (recovery: rest and easy aerobic only)',
    };
  }

  // Only evaluate the 7-day forward plan starting from today. Local date, like the app:
  // the UTC date is a day behind between midnight and 02:00 here, which shifted the week.
  const today = localDate();
  const plan = weeklyPlan
    .filter(e => e.date >= today)
    .slice(0, 7);

  const avgRide        = history?.averageRideMinutes ?? 0;
  const sessions       = plan.filter(e => e.type !== 'Rest').length;
  const sprintCount    = plan.filter(e => e.type === 'Sprint').length;
  const thresholdCount = plan.filter(e => e.type === 'Threshold').length;
  const vo2maxCount    = plan.filter(e => e.type === 'VO2Max').length;
  const tempoCount     = plan.filter(e => e.type === 'Tempo').length;
  const longRideCount  = plan.filter(e => e.type === 'LongRide' && isLongForAthlete(e, avgRide)).length;
  const restCount      = plan.filter(e => e.type === 'Rest').length;

  // Two quality sessions on consecutive days — what the plan prompt's SPACING rule forbids.
  let backToBack = 0;
  for (let i = 1; i < plan.length; i++) {
    if (QUALITY_TYPES.includes(plan[i].type) && QUALITY_TYPES.includes(plan[i - 1].type)) backToBack++;
  }

  const checks: CheckResult[] = [
    {
      label: 'Training sessions / week',
      planned: sessions,
      expected: rangeLabel(criteria.sessionsPerWeek),
      status: inRange(sessions, criteria.sessionsPerWeek),
    },
    {
      label: 'Rest days / week',
      planned: restCount,
      expected: rangeLabel(criteria.restDaysPerWeek),
      status: inRange(restCount, criteria.restDaysPerWeek),
    },
    {
      label: 'Sprint sessions / week',
      planned: sprintCount,
      expected: rangeLabel(criteria.sprintPerWeek),
      status: inRange(sprintCount, criteria.sprintPerWeek),
    },
    {
      label: 'Threshold sessions / week',
      planned: thresholdCount,
      expected: rangeLabel(criteria.thresholdPerWeek),
      status: inRange(thresholdCount, criteria.thresholdPerWeek),
    },
    {
      label: 'VO2Max sessions / week',
      planned: vo2maxCount,
      expected: rangeLabel(criteria.vo2maxPerWeek),
      status: inRange(vo2maxCount, criteria.vo2maxPerWeek),
    },
    {
      label: 'Tempo sessions / week',
      planned: tempoCount,
      expected: rangeLabel(criteria.tempoPerWeek),
      status: inRange(tempoCount, criteria.tempoPerWeek),
    },
    {
      label: `Long rides / week (≥ ${Math.round(Math.max(60, avgRide * 1.25))} min)`,
      planned: longRideCount,
      expected: rangeLabel(criteria.longRidePerWeek),
      status: inRange(longRideCount, criteria.longRidePerWeek),
    },
    {
      label: 'Quality sessions on consecutive days',
      planned: backToBack,
      expected: '0',
      status: backToBack === 0 ? 'ok' : 'fail',
    },
  ];

  // The plan prompt's FREQUENCY rule: match the recent rides-per-week average — at most one
  // more, and fewer only for a recovery reason. Both directions are checked: a max-only
  // rule made the model cut a 3-rides-a-week athlete to 2. In a recovery phase fewer is
  // the point, so only the upper bound applies there.
  if (history) {
    const avg = Math.round(history.ridesIn21Days / 3);
    const range = { min: trainingPhase === 'recovery' ? 0 : Math.max(1, avg - 1), max: avg + 1 };
    checks.push({
      label: 'Sessions vs recent frequency (avg ' + avg + ')',
      planned: sessions,
      expected: rangeLabel(range),
      status: inRange(sessions, range),
    });
  }

  const fails = checks.filter(c => c.status === 'fail').length;
  const warns = checks.filter(c => c.status === 'warn').length;
  const score = Math.max(0, 100 - fails * 20 - warns * 8);

  const verdict =
    score >= 90 ? 'excellent' :
    score >= 75 ? 'good' :
    score >= 55 ? 'acceptable' : 'poor';

  const issues = checks
    .filter(c => c.status !== 'ok')
    .map(c => `${c.label}: got ${c.planned}, expected ${c.expected}`);

  return { criteria, trainingPhase, checks, score, verdict, issues };
}
