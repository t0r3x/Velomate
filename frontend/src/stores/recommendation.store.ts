import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import {
  getRecommendation,
  postRefreshRecommendation,
  postSkipToday,
  postReschedule,
  postSyncWorkouts
} from '@/api/client'
import { useAuthStore } from '@/stores/auth.store'
import { isoDate } from '@/utils'
import type { Recommendation, RecState, SyncResult } from '@/types'

export const useRecommendationStore = defineStore('recommendation', () => {
  const state          = ref<RecState>('loading')
  const recommendation = ref<Recommendation | null>(null)
  const errorMessage   = ref('')

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
      recommendation.value = data as Recommendation
      state.value = 'loaded'
    } catch (err) {
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
    } catch {
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
    } catch {
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

  async function syncWorkouts(): Promise<SyncResult | null> {
    const plan = recommendation.value?.weeklyPlan || []
    const threshold = plan.find(e => e.type === 'Threshold' && e.status === 'planned')
    const scheduleDate = threshold?.date ?? (() => {
      const t = new Date(); t.setDate(t.getDate() + 1); return isoDate(t)
    })()
    try {
      return await postSyncWorkouts(scheduleDate)
    } catch {
      return null
    }
  }

  return {
    state,
    recommendation,
    errorMessage,
    hasSyncableWorkout,
    canSync,
    fetchCached,
    pollForUpdate,
    refresh,
    skipToday,
    reschedule,
    syncWorkouts
  }
})
