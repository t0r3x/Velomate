import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import {
  getRecommendation,
  postRefreshRecommendation,
  postSkipToday,
  postReschedule,
  postSyncWorkouts,
  postPauseTraining,
  postResumeTraining
} from '@/api/client'
import { useAuthStore } from '@/stores/auth.store'
import { isoDate, REFRESH_POLL_ATTEMPTS } from '@/utils'
import type { Recommendation, RecState, RefreshOutcome, RefreshStep, SyncResult } from '@/types'

export const useRecommendationStore = defineStore('recommendation', () => {
  const state          = ref<RecState>('loading')
  const recommendation = ref<Recommendation | null>(null)
  const errorMessage   = ref('')
  const pausedSince    = ref<string | null>(null)
  const pauseReason    = ref<string | null>(null)
  /** True while a background AI regen (triggered by refresh/skip/reschedule/resume/sync) is
   *  in flight — drives a small inline indicator instead of blanking the whole card. */
  const isRegenerating = ref(false)
  /** Which half of an explicit refresh is running: the Garmin sync the backend does first,
   *  then the AI. Null outside a refresh. Lets the card say what it is waiting on. */
  const refreshStep = ref<RefreshStep | null>(null)

  const hasSyncableWorkout = computed(() =>
    recommendation.value?.weeklyPlan?.some(e => e.status === 'planned') ?? false
  )

  const canSync = computed(() =>
    useAuthStore().isLoggedIn && hasSyncableWorkout.value && state.value === 'loaded'
  )

  /** Load cached plan from DB — no AI call. */
  async function fetchCached() {
    state.value = 'loading'
    try {
      const data = await getRecommendation()
      if ('notConfigured' in data) { state.value = 'not-configured'; return }
      if ('noData' in data)        { state.value = 'no-plan';        return }
      if ('paused' in data) {
        pausedSince.value    = data.pausedSince
        pauseReason.value    = data.pauseReason ?? null
        recommendation.value = null
        state.value          = 'paused'
        return
      }
      recommendation.value = data as Recommendation
      state.value = 'loaded'
    } catch (err) {
      console.error('[Recommendation] fetchCached failed:', err)
      errorMessage.value = 'Failed to connect to backend.'
      state.value = 'error'
    }
  }

  /**
   * Force-regenerate via AI. When a plan already exists, the backend syncs Garmin, starts
   * the AI in the background and responds with the current plan (`regenerating: true`) —
   * so this only shows the full loading state for the very first plan.
   *
   * Resolves only once the whole thing is over, new plan included, so the caller can keep
   * one continuous busy state and say how it ended. Without that, the button stopped
   * spinning after the Garmin step — exactly when the slow part was starting.
   */
  async function refresh(): Promise<RefreshOutcome> {
    const isFirstGeneration = state.value !== 'loaded'
    if (isFirstGeneration) state.value = 'loading'
    refreshStep.value = 'garmin'
    try {
      const result = await postRefreshRecommendation()
      recommendation.value = result
      state.value = 'loaded'
      if (!result.regenerating) return 'changed'
      refreshStep.value = 'ai'
      return await pollForUpdate(result.generatedAt, REFRESH_POLL_ATTEMPTS, true, true)
    } catch (err: unknown) {
      console.error('[Recommendation] refresh failed:', err)
      const e = err as { details?: string; message?: string }
      errorMessage.value = e.details || e.message || 'Failed to get recommendation.'
      state.value = 'error'
      return 'failed'
    } finally {
      refreshStep.value = null
    }
  }

  async function skipToday(date?: string): Promise<'ok' | 'failed'> {
    try {
      const result = await postSkipToday(date)
      recommendation.value = result
      state.value = 'loaded'
      if (result.regenerating) pollForUpdate(result.generatedAt, 20, true)
      return 'ok'
    } catch (err) {
      console.error('[Recommendation] skipToday failed:', err)
      await fetchCached()
      return 'failed'
    }
  }

  async function reschedule(fromDate: string, toDate: string): Promise<'ok' | 'failed'> {
    if (fromDate === toDate) return 'failed'
    try {
      const result = await postReschedule(fromDate, toDate)
      recommendation.value = result
      state.value = 'loaded'
      if (result.regenerating) pollForUpdate(result.generatedAt, 20, true)
      return 'ok'
    } catch (err) {
      console.error('[Recommendation] reschedule failed:', err)
      await fetchCached()
      return 'failed'
    }
  }

  /**
   * Poll GET /api/recommendation silently in the background until `generatedAt` changes.
   * Called both for a *confirmed* regen (the backend said `regenerating: true` after
   * refresh/skip/reschedule/resume/activity-sync) and speculatively on every dashboard
   * mount, in case the server's own startup/hourly auto-check is regenerating independently
   * with no other way to signal the frontend. Only the confirmed case shows `isRegenerating`
   * — the speculative mount-time check has no evidence anything is actually happening, so
   * it must stay invisible or the banner would flash on every single startup.
   *
   * `detectFailure` ends the poll as soon as the backend reports nothing in flight while
   * the plan is unchanged — the generation finished without writing, i.e. it failed. Only
   * for a generation known to be running already (an explicit refresh): the speculative
   * mount-time poll is waiting for one that may not have started yet.
   */
  async function pollForUpdate(
    knownGeneratedAt: string | undefined,
    maxAttempts = 20,
    showIndicator = false,
    detectFailure = false
  ): Promise<RefreshOutcome> {
    if (showIndicator) isRegenerating.value = true
    try {
      for (let i = 0; i < maxAttempts; i++) {
        await new Promise<void>(r => setTimeout(r, 4000))
        try {
          const data = await getRecommendation()
          if ('notConfigured' in data || 'noData' in data || 'paused' in data) return 'failed'
          const rec = data as Recommendation
          if (rec.generatedAt !== knownGeneratedAt) {
            recommendation.value = rec
            state.value = 'loaded'
            return rec.changedEntries?.length ? 'changed' : 'unchanged'
          }
          if (detectFailure && rec.regenerating === false) return 'failed'
        } catch { /* ignore poll errors */ }
      }
      return 'timeout'
    } finally {
      if (showIndicator) isRegenerating.value = false
    }
  }

  async function pauseTraining(reason?: string): Promise<boolean> {
    try {
      const result = await postPauseTraining(reason)
      pausedSince.value    = result.pausedSince
      pauseReason.value    = result.pauseReason ?? null
      recommendation.value = null
      state.value          = 'paused'
      return true
    } catch (err) {
      console.error('[Recommendation] pauseTraining failed:', err)
      return false
    }
  }

  async function resumeTraining(): Promise<boolean> {
    try {
      const result = await postResumeTraining()
      pausedSince.value = null
      pauseReason.value = null
      // Shows the pre-pause plan immediately; the pause-aware regen runs in the background.
      await fetchCached()
      if (result.regenerating) pollForUpdate(recommendation.value?.generatedAt, 20, true)
      return true
    } catch (err) {
      console.error('[Recommendation] resumeTraining failed:', err)
      state.value = 'error'
      return false
    }
  }

  async function syncWorkouts(): Promise<SyncResult | null> {
    const plan = recommendation.value?.weeklyPlan || []
    const threshold = plan.find(e => e.type === 'Threshold' && e.status === 'planned')
    const scheduleDate = threshold?.date ?? (() => {
      const t = new Date(); t.setDate(t.getDate() + 1); return isoDate(t)
    })()
    try {
      return await postSyncWorkouts(scheduleDate)
    } catch (err) {
      console.error('[Recommendation] syncWorkouts failed:', err)
      return null
    }
  }

  return {
    state,
    recommendation,
    errorMessage,
    pausedSince,
    pauseReason,
    isRegenerating,
    refreshStep,
    hasSyncableWorkout,
    canSync,
    fetchCached,
    pollForUpdate,
    refresh,
    skipToday,
    reschedule,
    pauseTraining,
    resumeTraining,
    syncWorkouts
  }
})
