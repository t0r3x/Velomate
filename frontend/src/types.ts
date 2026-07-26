// Shared TypeScript types — mirrors backend/src/types.ts + API response shapes

export interface HeartRateZone {
  min: number
  max: number
}

export interface HrZones {
  z1: HeartRateZone
  z2: HeartRateZone
  z3: HeartRateZone
  z4: HeartRateZone
  z5: HeartRateZone
}

export interface UserHRProfile {
  maxHr: number
  lthr: number
  zones: HrZones
  hasCustomOverrides: boolean
  lastUpdated: string
}

// ── Plan types ────────────────────────────────────────────────────────────────

export type PlanEntryStatus =
  | 'planned'
  | 'completed'
  | 'completed-partial'
  | 'completed-mismatch'
  | 'skipped'
  | 'auto-skipped'

export type WorkoutType = 'Sprint' | 'VO2Max' | 'Threshold' | 'Tempo' | 'LongRide' | 'Rest'

export interface WorkoutStep {
  stepType: 'WarmUp' | 'Run' | 'Recovery' | 'Cooldown'
  durationSec: number
  zone: 'z1' | 'z2' | 'z3' | 'z4' | 'z5'
  label: string
}

export interface WorkoutStructure {
  totalMinutes: number
  steps: WorkoutStep[]
}

export interface PlanEntry {
  date: string
  type: string
  reason: string
  status: PlanEntryStatus
  structure?: WorkoutStructure | null
  executionScore?: number | null
  executionNote?: string | null
  /** Client-only: true when this entry was synthesized because the backend's
   *  weeklyPlan has no data for this date (not a real AI-planned rest day). */
  isPlaceholder?: boolean
  /** Client-only: true when a placeholder's date is before today — refreshing can
   *  never fill this in, since generation only ever plans forward, never retroactively. */
  isPastPlaceholder?: boolean
}

export interface LoadAssessment {
  fatigue: string
  weeklyLoadTrend: string
  insight: string
}

export interface Recommendation {
  workoutType: WorkoutType
  reason: string
  priority: string
  weeklyPlan: PlanEntry[]
  nextWeekFocus: string | null
  loadAssessment: LoadAssessment
  generatedAt: string
  stale?: boolean
  regenFailed?: boolean
}

// ── Activity types ────────────────────────────────────────────────────────────

export interface Activity {
  activityId: string
  name: string
  type: string
  startTime: string
  distanceKm: number
  durationMinutes: number
  averageHr: number
  maxHr: number
  averagePower: number
  maxPower: number
  timeInZones?: number[]
  perceivedExertion?: number | null
  feelingAfterExercise?: number | null
  fetchedAt: string
}

export interface Analysis {
  totalCyclingRides: number
  maxRecordedHr: number
  estimatedMaxHr: number
  estimatedLthr: number
  averageRideDurationMinutes: number
  suggestedZones?: HrZones
  updatedAt: string
}

// ── Sync result ───────────────────────────────────────────────────────────────

export interface SyncedWorkout {
  name: string
  scheduledDate?: string
  scheduleError?: string
}

export interface SyncResult {
  workouts: SyncedWorkout[]
  usingFallback?: string[]
  scheduleErrors?: string[]
}

// ── API response variants ─────────────────────────────────────────────────────

export type RecState = 'not-configured' | 'no-plan' | 'loading' | 'loaded' | 'error' | 'paused'

export interface PausedResponse {
  paused: true
  pausedSince: string
  pauseReason?: string
}

export interface GeminiKeyStatus {
  hasKey: boolean
  maskedKey: string
  setupComplete: boolean
  preferredLongRideDays: string[]
  geminiModel: string
  inactivityPauseDays: number
  instantScoreOnNewActivity: boolean
}

export interface DashboardResponse {
  activities: Activity[]
  analysis: Analysis | null
  profile: UserHRProfile | null
}

export interface ActivitiesRefreshResponse {
  activities: Activity[]
  analysis: Analysis | null
  currentProfile: UserHRProfile | null
  newCount: number
  planRegenTriggered?: boolean
}
