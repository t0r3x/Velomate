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

/** One future day whose workout type changed in the latest regeneration. */
export interface PlanChange {
  date: string
  from: string
  to:   string
}

export interface Recommendation {
  workoutType: WorkoutType
  reason: string
  priority: string
  weeklyPlan: PlanEntry[]
  nextWeekFocus: string | null
  /** The model's explanation for why this plan differs from the previous one. */
  changeNote: string | null
  /** Computed server-side, never taken from the model — the authoritative list. */
  changedEntries: PlanChange[]
  loadAssessment: LoadAssessment
  generatedAt: string
  stale?: boolean
  /** True when this response is the pre-regen data — a fresh AI read is running in the
   *  background and the frontend should poll for it (see pollForUpdate). */
  regenerating?: boolean
}

// ── Activity types ────────────────────────────────────────────────────────────

/**
 * Reported when reacting to new athlete input replaced a free-mode suggestion that was
 * already on the watch. The Garmin workout stays on their calendar, so only they can
 * clean it up — the UI has to say so.
 */
export interface ReplacedSyncedWorkout {
  type: string
  date: string
}

/** How the athlete said they felt on a given day — recorded without needing a ride. */
export interface DailyCheckin {
  date:      string
  feeling:   number   // 1 = exhausted … 5 = strong
  note:      string | null
  updatedAt: string
}

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
  freeTrainingMode: boolean
}

// ── Free training mode ────────────────────────────────────────────────────────
// One dateless suggestion instead of a 14-day plan. It only gains a date when the
// athlete syncs it — that press date is what makes it traceable afterwards.

export type FreeSuggestionStatus =
  | 'open' | 'synced' | 'completed' | 'dismissed' | 'superseded'

export interface FreeSuggestion {
  id: number
  workoutType: WorkoutType
  reason: string
  priority: string
  /** AI guidance on WHEN to ride this — free mode's stand-in for a calendar slot. */
  coachNote: string | null
  structure: WorkoutStructure | null
  loadAssessment: LoadAssessment | null
  status: FreeSuggestionStatus
  generatedAt: string
  syncedAt: string | null
  /** Date the sync button was pressed — also the Garmin calendar date and name prefix. */
  syncedForDate: string | null
  completedDate: string | null
  completedActivityId: string | null
  executionScore: number | null
  executionNote: string | null
}

export interface FreeTraining {
  suggestion: FreeSuggestion
  history: FreeSuggestion[]
  stale?: boolean
  /** True when this response is the pre-regen suggestion — a fresh AI read is running in
   *  the background and the frontend should poll for it (see pollForUpdate). */
  regenerating?: boolean
}

export type FreeState =
  | 'not-configured' | 'no-suggestion' | 'loading' | 'loaded' | 'error' | 'paused'

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
