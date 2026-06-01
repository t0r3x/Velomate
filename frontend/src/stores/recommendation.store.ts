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
import { isoDate } from '@/utils'
import type { Recommendation, RecState, SyncResult } from '@/types'

export const useRecommendationStore = defineStore('recommendation', () => {
  const state          = ref<RecState>('loading')
  const recommendation = ref<Recommendation | null>(null)
  const errorMessage   = ref('')
  const pausedSince    = ref<string | null>(null)
  const pauseReason    = ref<string | null>(null)

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

  /** Force-regenerate via AI. */
  async function refresh() {
    state.value = 'loading'
    try {
      recommendation.value = await postRefreshRecommendation()
      state.value = 'loaded'
    } catch (err: unknown) {
      console.error('[Recommendation] refresh failed:', err)
      const e = err as { details?: string; message?: string }
      errorMessage.value = e.details || e.message || 'Failed to get recommendation.'
      state.value = 'error'
    }
  }

  async function skipToday(): Promise<boolean> {
    try {
      recommendation.value = await postSkipToday()
      state.value = 'loaded'
      return true
    } catch (err) {
      console.error('[Recommendation] skipToday failed:', err)
      return false
    }
  }

  async function reschedule(fromDate: string): Promise<boolean> {
    const toDate = isoDate()
    if (fromDate === toDate) return false
    try {
      recommendation.value = await postReschedule(fromDate, toDate)
      state.value = 'loaded'
      return true
    } catch (err) {
      console.error('[Recommendation] reschedule failed:', err)
      return false
    }
  }

  /**
   * Poll GET /api/recommendation silently in the background until `generatedAt`
   * changes. Called after an activity sync triggers a non-blocking AI regen so
   * execution scores appear automatically once the AI response arrives.
   */
  async function pollForUpdate(knownGeneratedAt: string | undefined, maxAttempts = 10) {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise<void>(r => setTimeout(r, 4000))
      try {
        const data = await getRecommendation()
        if ('notConfigured' in data || 'noData' in data) return
        const rec = data as Recommendation
        if (rec.generatedAt !== knownGeneratedAt) {
          recommendation.value = rec
          state.value = 'loaded'
          return
        }
      } catch { /* ignore poll errors */ }
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
    state.value = 'loading'
    try {
      await postResumeTraining()
      pausedSince.value = null
      pauseReason.value = null
      await fetchCached()
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
