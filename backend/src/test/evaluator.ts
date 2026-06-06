import type { FitnessLevel } from './athletes';
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

const CRITERIA: Record<FitnessLevel, Criteria> = {
  beginner: {
    sessionsPerWeek:  { min: 2, max: 3 },
    sprintPerWeek:    { min: 0, max: 0 },
    thresholdPerWeek: { min: 0, max: 0 },
    vo2maxPerWeek:    { min: 0, max: 0 },
    longRidePerWeek:  { min: 0, max: 1 },
    restDaysPerWeek:  { min: 4, max: 5 },
    description: 'Easy aerobic work only. No intensity. Build the habit.',
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
    sessionsPerWeek:  { min: 6, max: 7 },
    sprintPerWeek:    { min: 2, max: 3 },
    thresholdPerWeek: { min: 2, max: 3 },
    vo2maxPerWeek:    { min: 0, max: 1 },
    longRidePerWeek:  { min: 1, max: 2 },
    restDaysPerWeek:  { min: 0, max: 1 },
    description: 'Maximum load. Structured intervals every day. Minimal rest.',
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

export function evaluatePlan(
  level: FitnessLevel,
  weeklyPlan: PlanEntry[]
): EvaluationResult {
  const criteria = CRITERIA[level];

  // Only look at the 7-day forward plan (today + 6), ignore scored history
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

  return { criteria, checks, score, verdict, issues };
}
