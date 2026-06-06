import type { FitnessLevel, TrainingPhase } from './athletes';
import type { PlanEntry } from '../services/database.service';

interface Range { min: number; max: number }

interface Criteria {
  sessionsPerWeek: Range;
  sprintPerWeek: Range;
  thresholdPerWeek: Range;
  vo2maxPerWeek: Range;
  longRidePerWeek: Range;
  restDaysPerWeek: Range;
  description: string;
}

// Base criteria per fitness level — assumes a normal build/base week.
// Taper and recovery phases are adjusted dynamically in evaluatePlan().
const CRITERIA: Record<FitnessLevel, Criteria> = {
  beginner: {
    sessionsPerWeek:  { min: 2, max: 3 },
    sprintPerWeek:    { min: 0, max: 0 },
    thresholdPerWeek: { min: 0, max: 0 },
    vo2maxPerWeek:    { min: 0, max: 0 },
    longRidePerWeek:  { min: 0, max: 1 },
    restDaysPerWeek:  { min: 4, max: 5 },
    description: 'Easy aerobic work only. No intensity. Build the habit first.',
  },
  recreational: {
    sessionsPerWeek:  { min: 3, max: 4 },
    sprintPerWeek:    { min: 0, max: 0 },
    thresholdPerWeek: { min: 0, max: 1 },
    vo2maxPerWeek:    { min: 0, max: 0 },
    longRidePerWeek:  { min: 1, max: 1 },
    restDaysPerWeek:  { min: 3, max: 4 },
    description: 'Mostly aerobic with optional light structure. One long ride per week.',
  },
  intermediate: {
    sessionsPerWeek:  { min: 4, max: 5 },
    sprintPerWeek:    { min: 0, max: 1 },
    thresholdPerWeek: { min: 1, max: 2 },
    vo2maxPerWeek:    { min: 0, max: 1 },
    longRidePerWeek:  { min: 1, max: 1 },
    restDaysPerWeek:  { min: 2, max: 3 },
    description: 'Z2 base + 1-2 hard sessions + 1 long ride. Progressive overload.',
  },
  advanced: {
    sessionsPerWeek:  { min: 5, max: 6 },
    sprintPerWeek:    { min: 1, max: 2 },
    thresholdPerWeek: { min: 1, max: 2 },
    vo2maxPerWeek:    { min: 0, max: 1 },
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
    longRidePerWeek:  { min: 1, max: 2 },
    restDaysPerWeek:  { min: 0, max: 2 },
    description: 'High-volume structured training. Race-specific periodization with regular Z4-Z5 sessions.',
  },
};

type CheckStatus = 'ok' | 'warn' | 'fail';

interface CheckResult {
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

export function evaluatePlan(
  level: FitnessLevel,
  weeklyPlan: PlanEntry[],
  trainingPhase: TrainingPhase = 'build'
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
      restDaysPerWeek:  { min: clamp(criteria.restDaysPerWeek.max, 3, 6), max: 6 },
      description: criteria.description + ' (recovery: rest and easy aerobic only)',
    };
  }

  // Only evaluate the 7-day forward plan starting from today
  const today = new Date().toISOString().slice(0, 10);
  const plan = weeklyPlan
    .filter(e => e.date >= today)
    .slice(0, 7);

  const sessions       = plan.filter(e => e.type !== 'Rest').length;
  const sprintCount    = plan.filter(e => e.type === 'Sprint').length;
  const thresholdCount = plan.filter(e => e.type === 'Threshold').length;
  const vo2maxCount    = plan.filter(e => e.type === 'VO2Max').length;
  const longRideCount  = plan.filter(e => e.type === 'LongRide').length;
  const restCount      = plan.filter(e => e.type === 'Rest').length;

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
      label: 'Long rides / week',
      planned: longRideCount,
      expected: rangeLabel(criteria.longRidePerWeek),
      status: inRange(longRideCount, criteria.longRidePerWeek),
    },
  ];

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
