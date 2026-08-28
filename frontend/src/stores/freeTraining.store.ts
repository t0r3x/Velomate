import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import {
  getFreeTraining,
  postFreeTrainingRefresh,
  postFreeTrainingDismiss,
  postFreeTrainingSync,
  postPauseTraining,
  postResumeTraining
} from '@/api/client'
import { useAuthStore } from '@/stores/auth.store'
import type { FreeSuggestion, FreeState, SyncResult } from '@/types'

/**
 * Free training mode: one dateless "next workout" suggestion instead of the 14-day plan.
 * Deliberately mirrors recommendation.store's state machine and method names — the two
 * modes swap out one card in the dashboard, so keeping their shapes aligned means the
 * surrounding components behave identically whichever mode is active.
 */
export const useFreeTrainingStore = defineStore('freeTraining', () => {
  const state        = ref<FreeState>('loading')
  const suggestion   = ref<FreeSuggestion | null>(null)
  const history      = ref<FreeSuggestion[]>([])
  const stale        = ref(false)
  const errorMessage = ref('')
  const pausedSince  = ref<string | null>(null)
  const pauseReason  = ref<string | null>(null)

  /** A Rest suggestion is real advice, but there is no workout file to push to Garmin. */
  const isSyncable = computed(() =>
    !!suggestion.value && suggestion.value.workoutType !== 'Rest'
  )

  const canSync = computed(() =>
    useAuthStore().isLoggedIn && isSyncable.value && state.value === 'loaded'
  )

  const isSynced = computed(() => suggestion.value?.status === 'synced')

  function applyPayload(data: any) {
    suggestion.value = data.suggestion
    history.value    = Array.isArray(data.history) ? data.history : []
    stale.value      = !!data.stale
    state.value      = 'loaded'
  }

  /** Load the stored suggestion — no AI call. */
  async function fetchCached() {
    state.value = 'loading'
    try {
      const data = await getFreeTraining()
      if ('notConfigured' in data) { state.value = 'not-configured'; return }
      if ('noSuggestion' in data)  { state.value = 'no-suggestion';  return }
      if ('paused' in data) {
        pausedSince.value = data.pausedSince
        pauseReason.value = data.pauseReason ?? null
        suggestion.value  = null
        state.value       = 'paused'
        return
      }
      applyPayload(data)
    } catch (err) {
      console.error('[FreeTraining] fetchCached failed:', err)
      errorMessage.value = 'Failed to connect to backend.'
      state.value = 'error'
    }
  }

  /** Ask the AI for a new suggestion — also the "generate my first one" path. */
  async function refresh() {
    state.value = 'loading'
    try {
      applyPayload(await postFreeTrainingRefresh())
    } catch (err: unknown) {
      console.error('[FreeTraining] refresh failed:', err)
      const e = err as { details?: string; message?: string }
      errorMessage.value = e.details || e.message || 'Failed to get a suggestion.'
      state.value = 'error'
    }
  }

  /**
   * "Not this one" — reject the current suggestion and ask for another. Recorded
   * separately from a plain refresh so the AI learns what this athlete turns down.
   */
  async function dismiss(): Promise<'ok' | 'dismissed' | 'failed'> {
    state.value = 'loading'
    try {
      const result = await postFreeTrainingDismiss()
      applyPayload(result)
      return result.regenFailed ? 'dismissed' : 'ok'
    } catch (err) {
      console.error('[FreeTraining] dismiss failed:', err)
      await fetchCached()
      return 'failed'
    }
  }

  /**
   * Push the suggestion to Garmin. The backend stamps it with today's date — the day the
   * button was pressed — which becomes the workout name and its calendar slot.
   */
  async function syncWorkout(): Promise<SyncResult | null> {
    try {
      const result = await postFreeTrainingSync()
      applyPayload(result)
      return result
    } catch (err) {
      console.error('[FreeTraining] syncWorkout failed:', err)
      return null
    }
  }

  // Pause/resume are mode-agnostic on the backend (/api/training/*); free mode just needs
  // its own copy of the resulting UI state, since it owns the card while it is active.
  async function pauseTraining(reason?: string): Promise<boolean> {
    try {
      const result = await postPauseTraining(reason)
      pausedSince.value = result.pausedSince
      pauseReason.value = result.pauseReason ?? null
      suggestion.value  = null
      state.value       = 'paused'
      return true
    } catch (err) {
      console.error('[FreeTraining] pauseTraining failed:', err)
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
      console.error('[FreeTraining] resumeTraining failed:', err)
      state.value = 'error'
      return false
    }
  }

  /**
   * Poll silently until the stored suggestion changes, after a non-blocking backend regen
   * (a newly matched ride triggers one). Mirrors recommendation.store's pollForUpdate.
   */
  async function pollForUpdate(knownGeneratedAt: string | undefined, maxAttempts = 20) {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise<void>(r => setTimeout(r, 4000))
      try {
        const data = await getFreeTraining()
        if ('notConfigured' in data || 'noSuggestion' in data || 'paused' in data) return
        if (data.suggestion?.generatedAt !== knownGeneratedAt) {
          applyPayload(data)
          return
        }
      } catch { /* ignore poll errors */ }
    }
  }

  return {
    state,
    suggestion,
    history,
    stale,
    errorMessage,
    pausedSince,
    pauseReason,
    isSyncable,
    isSynced,
    canSync,
    fetchCached,
    pollForUpdate,
    refresh,
    dismiss,
    syncWorkout,
    pauseTraining,
    resumeTraining
  }
})
