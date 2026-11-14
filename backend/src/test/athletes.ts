export type FitnessLevel = 'beginner' | 'recreational' | 'intermediate' | 'advanced' | 'pro';
export type TrainingPhase = 'base' | 'build' | 'taper' | 'recovery';
export type RideType = 'easy' | 'moderate' | 'threshold' | 'sprint' | 'long';

export interface RideSpec {
  daysAgo: number;
  type: RideType;
  durationMin: number;
  /** Ridden on the bike with the power meter (needs `ftp` on the athlete). */
  power?: boolean;
  /** No heart rate strap: HR 0 and an all-zero zone split, the way Garmin can send it. */
  noHr?: boolean;
}

export interface AthleteDefinition {
  id: string;
  name: string;
  age: number;
  fitnessLevel: FitnessLevel;
  trainingPhase: TrainingPhase;
  profile: { maxHr: number; lthr: number };
  preferences: { preferredLongRideDays: string[]; goals: string };
  /** FTP in watts, for athletes who own a power meter. Stored as if it came from Garmin. */
  ftp?: number;
  rides: RideSpec[];
}

// ── Ride physiology helpers ───────────────────────────────────────────────────

const SPEED_KMH: Record<RideType, number> = {
  easy: 20, moderate: 23, threshold: 27, sprint: 24, long: 22,
};

const AVG_HR_RATIO: Record<RideType, number> = {
  easy: 0.73, moderate: 0.83, threshold: 0.96, sprint: 0.88, long: 0.77,
};

const MAX_HR_RATIO: Record<RideType, number> = {
  easy: 0.91, moderate: 0.97, threshold: 0.976, sprint: 0.995, long: 0.93,
};

// Zone time percentages [z1, z2, z3, z4, z5] — Garmin % max HR zones
const ZONE_PCT: Record<RideType, number[]> = {
  easy:      [0.15, 0.70, 0.12, 0.03, 0.00],
  moderate:  [0.10, 0.50, 0.28, 0.12, 0.00],
  threshold: [0.10, 0.22, 0.18, 0.42, 0.08],
  sprint:    [0.08, 0.20, 0.20, 0.30, 0.22],
  long:      [0.10, 0.72, 0.15, 0.03, 0.00],
};

// Garmin raw values (0-100): rpe / 10 → 1–10 Borg, feeling / 25 + 1 → 1–5
const RPE_RAW: Record<RideType, number> = {
  easy: 55, moderate: 65, threshold: 80, sprint: 85, long: 60,
};
const FEEL_RAW: Record<RideType, number> = {
  easy: 75, moderate: 75, threshold: 50, sprint: 50, long: 75,
};

// Whole-ride intensity factor per ride type (warm-up and recoveries included), and the best
// 20 minutes as a share of FTP. Plausible values, matching the bands ACTIVITY_DATA_NOTES gives.
const RIDE_IF: Record<RideType, number> = {
  easy: 0.62, moderate: 0.74, threshold: 0.88, sprint: 0.78, long: 0.68,
};
const BEST20_OF_FTP: Record<RideType, number> = {
  easy: 0.68, moderate: 0.82, threshold: 0.98, sprint: 0.85, long: 0.75,
};

export function buildActivity(
  athleteId: string,
  ride: RideSpec,
  profile: { maxHr: number; lthr: number },
  ftp?: number
): any {
  const date = new Date();
  date.setDate(date.getDate() - ride.daysAgo);
  date.setHours(8, 30, 0, 0);

  const totalSec = ride.durationMin * 60;
  const zones = ZONE_PCT[ride.type].map(p => Math.round(p * totalSec));

  const rideNames: Record<RideType, string> = {
    easy:      'Easy Ride',
    moderate:  'Moderate Ride',
    threshold: 'Threshold Intervals',
    sprint:    'Sprint Session',
    long:      'Long Ride',
  };

  return {
    activityId: `bt-${athleteId}-d${ride.daysAgo}`,
    name: rideNames[ride.type],
    type: 'cycling',
    startTime: date.toISOString(),
    distanceKm: Math.round((SPEED_KMH[ride.type] * ride.durationMin / 60) * 10) / 10,
    durationMinutes: ride.durationMin,
    averageHr: Math.round(profile.lthr * AVG_HR_RATIO[ride.type]),
    maxHr: Math.round(profile.maxHr * MAX_HR_RATIO[ride.type]),
    ...powerFields(ride, ftp),
    ...(ride.noHr ? { averageHr: 0, maxHr: 0 } : {}),
    timeInZones: ride.noHr ? [0, 0, 0, 0, 0] : zones,
    perceivedExertion: RPE_RAW[ride.type],
    feelingAfterExercise: FEEL_RAW[ride.type],
  };
}

function powerFields(ride: RideSpec, ftp?: number) {
  if (!ride.power || !ftp) return { averagePower: 0, maxPower: 0 };
  const np = Math.round(ftp * RIDE_IF[ride.type]);
  return {
    averagePower:  Math.round(np * 0.92),
    normPower:     np,
    max20MinPower: ride.durationMin >= 20 ? Math.round(ftp * BEST20_OF_FTP[ride.type]) : null,
    maxPower:      Math.round(ftp * (ride.type === 'sprint' ? 3.2 : 1.9)),
  };
}

// ── Athlete definitions ───────────────────────────────────────────────────────

export const ATHLETES: AthleteDefinition[] = [
  {
    id: 'emma',
    name: 'Emma Santos',
    age: 28,
    fitnessLevel: 'beginner',
    trainingPhase: 'base',
    profile: { maxHr: 187, lthr: 165 },
    preferences: {
      preferredLongRideDays: ['Sunday'],
      goals: 'Stay active and enjoy cycling. Building basic fitness for the first time.',
    },
    rides: [
      { daysAgo: 2,  type: 'easy', durationMin: 30 },
      { daysAgo: 7,  type: 'easy', durationMin: 45 },
      { daysAgo: 9,  type: 'easy', durationMin: 30 },
      { daysAgo: 14, type: 'easy', durationMin: 45 },
      { daysAgo: 16, type: 'easy', durationMin: 30 },
      { daysAgo: 20, type: 'easy', durationMin: 35 },
    ],
  },
  {
    id: 'marc',
    name: 'Marc de Vries',
    age: 42,
    fitnessLevel: 'recreational',
    trainingPhase: 'base',
    profile: { maxHr: 175, lthr: 154 },
    preferences: {
      preferredLongRideDays: ['Saturday', 'Sunday'],
      goals: 'Maintain fitness and enjoy weekend rides. Lose a few kilos.',
    },
    rides: [
      { daysAgo: 1,  type: 'moderate', durationMin: 55 },
      { daysAgo: 3,  type: 'easy',     durationMin: 50 },
      { daysAgo: 7,  type: 'long',     durationMin: 70 },
      { daysAgo: 10, type: 'easy',     durationMin: 50 },
      { daysAgo: 12, type: 'moderate', durationMin: 60 },
      { daysAgo: 14, type: 'long',     durationMin: 75 },
      { daysAgo: 17, type: 'easy',     durationMin: 50 },
      { daysAgo: 19, type: 'moderate', durationMin: 55 },
      { daysAgo: 21, type: 'long',     durationMin: 70 },
    ],
  },
  {
    id: 'sarah',
    name: 'Sarah Müller',
    age: 35,
    fitnessLevel: 'intermediate',
    trainingPhase: 'build',
    profile: { maxHr: 181, lthr: 162 },
    preferences: {
      preferredLongRideDays: ['Saturday'],
      goals: 'Preparing for a Gran Fondo in 3 months. Improve endurance and threshold power.',
    },
    rides: [
      { daysAgo: 1,  type: 'easy',      durationMin: 60 },
      { daysAgo: 3,  type: 'threshold', durationMin: 70 },
      { daysAgo: 5,  type: 'easy',      durationMin: 60 },
      { daysAgo: 7,  type: 'long',      durationMin: 90 },
      { daysAgo: 9,  type: 'easy',      durationMin: 65 },
      { daysAgo: 11, type: 'threshold', durationMin: 75 },
      { daysAgo: 13, type: 'easy',      durationMin: 60 },
      { daysAgo: 14, type: 'long',      durationMin: 95 },
      { daysAgo: 16, type: 'easy',      durationMin: 60 },
      { daysAgo: 18, type: 'threshold', durationMin: 70 },
      { daysAgo: 21, type: 'long',      durationMin: 90 },
    ],
  },
  {
    id: 'thomas',
    name: 'Thomas Bakker',
    age: 31,
    fitnessLevel: 'advanced',
    trainingPhase: 'build',
    profile: { maxHr: 177, lthr: 160 },
    preferences: {
      preferredLongRideDays: ['Saturday', 'Sunday'],
      goals: 'Competitive training. Target a local criterium race in 6 weeks.',
    },
    rides: [
      { daysAgo: 1,  type: 'easy',      durationMin: 75 },
      { daysAgo: 2,  type: 'sprint',    durationMin: 60 },
      { daysAgo: 4,  type: 'threshold', durationMin: 85 },
      { daysAgo: 5,  type: 'easy',      durationMin: 60 },
      { daysAgo: 7,  type: 'long',      durationMin: 120 },
      { daysAgo: 8,  type: 'easy',      durationMin: 75 },
      { daysAgo: 9,  type: 'sprint',    durationMin: 60 },
      { daysAgo: 11, type: 'threshold', durationMin: 90 },
      { daysAgo: 13, type: 'easy',      durationMin: 75 },
      { daysAgo: 14, type: 'long',      durationMin: 130 },
      { daysAgo: 15, type: 'easy',      durationMin: 60 },
      { daysAgo: 16, type: 'sprint',    durationMin: 55 },
      { daysAgo: 18, type: 'threshold', durationMin: 85 },
      { daysAgo: 20, type: 'easy',      durationMin: 75 },
      { daysAgo: 21, type: 'long',      durationMin: 120 },
    ],
  },
  {
    id: 'alex',
    name: 'Alex Ivanov',
    age: 26,
    fitnessLevel: 'pro',
    trainingPhase: 'build',
    profile: { maxHr: 193, lthr: 174 },
    preferences: {
      preferredLongRideDays: ['Saturday', 'Sunday'],
      goals: 'Peak performance for an upcoming stage race in 4 weeks.',
    },
    rides: [
      { daysAgo: 1,  type: 'easy',      durationMin: 90 },
      { daysAgo: 2,  type: 'sprint',    durationMin: 75 },
      { daysAgo: 3,  type: 'threshold', durationMin: 90 },
      { daysAgo: 4,  type: 'easy',      durationMin: 90 },
      { daysAgo: 5,  type: 'sprint',    durationMin: 75 },
      { daysAgo: 7,  type: 'long',      durationMin: 150 },
      { daysAgo: 8,  type: 'long',      durationMin: 120 },
      { daysAgo: 9,  type: 'easy',      durationMin: 90 },
      { daysAgo: 10, type: 'sprint',    durationMin: 75 },
      { daysAgo: 11, type: 'threshold', durationMin: 90 },
      { daysAgo: 12, type: 'easy',      durationMin: 90 },
      { daysAgo: 14, type: 'long',      durationMin: 165 },
      { daysAgo: 15, type: 'long',      durationMin: 120 },
      { daysAgo: 16, type: 'easy',      durationMin: 90 },
      { daysAgo: 17, type: 'sprint',    durationMin: 75 },
      { daysAgo: 18, type: 'threshold', durationMin: 90 },
      { daysAgo: 19, type: 'easy',      durationMin: 90 },
      { daysAgo: 21, type: 'long',      durationMin: 150 },
    ],
  },
  {
    // Two bikes, a power meter on one of them, and a hard session yesterday with the heart
    // rate strap forgotten. Checks that power-only rides count (yesterday is a hard effort,
    // so today must not be another quality day) and that power=n/a rides are not penalised.
    id: 'joris',
    name: 'Joris Peeters',
    age: 38,
    fitnessLevel: 'intermediate',
    trainingPhase: 'build',
    profile: { maxHr: 184, lthr: 165 },
    ftp: 235,
    preferences: {
      preferredLongRideDays: ['Sunday'],
      goals: 'Gravel events in spring. Rides a road bike and a gravel bike; only the gravel bike has a power meter.',
    },
    rides: [
      { daysAgo: 1,  type: 'threshold', durationMin: 75,  power: true, noHr: true },
      { daysAgo: 3,  type: 'easy',      durationMin: 60 },
      { daysAgo: 5,  type: 'long',      durationMin: 120, power: true },
      { daysAgo: 7,  type: 'moderate',  durationMin: 70 },
      { daysAgo: 9,  type: 'threshold', durationMin: 70,  power: true },
      { daysAgo: 12, type: 'long',      durationMin: 110, power: true },
      { daysAgo: 14, type: 'easy',      durationMin: 60 },
      { daysAgo: 16, type: 'threshold', durationMin: 70 },
      { daysAgo: 19, type: 'long',      durationMin: 115, power: true },
      { daysAgo: 21, type: 'easy',      durationMin: 55 },
    ],
  },
];
