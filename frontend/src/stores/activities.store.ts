import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getDashboard, postActivitiesRefresh, postActivityFeedback } from '@/api/client'
import { useProfileStore } from '@/stores/profile.store'
import type { Activity, Analysis } from '@/types'

export const useActivitiesStore = defineStore('activities', () => {
  const activities = ref<Activity[]>([])
  const analysis   = ref<Analysis | null>(null)
  const loading    = ref(false)

  /** Fast initial load from DB — no Garmin call. */
  async function loadFromDb() {
    try {
      const data = await getDashboard()
      activities.value = data.activities || []
      analysis.value   = data.analysis
      if (data.profile) {
        useProfileStore().setFromDashboard(data.profile)
      }
    } catch (err) {
      console.warn('[Activities] loadFromDb failed:', err)
    }
  }

  /** Full Garmin sync: fetches new rides, updates DB, re-runs analysis. */
  async function syncFromGarmin(): Promise<{ newCount: number; planRegenTriggered: boolean }> {
    loading.value = true
    try {
      const data = await postActivitiesRefresh()
      activities.value = data.activities || []
      analysis.value   = data.analysis
      if (data.currentProfile) {
        useProfileStore().setFromDashboard(data.currentProfile)
      }
      return { newCount: data.newCount || 0, planRegenTriggered: data.planRegenTriggered ?? false }
    } catch (err) {
      console.error('[Activities] syncFromGarmin failed:', err)
      throw err
    } finally {
      loading.value = false
    }
  }

  /**
   * Save the athlete's own rating of a ride.
   * The backend writes to Garmin before it writes here, so a false return means the
   * rating was not stored anywhere and the UI must keep showing the previous state.
   */
  async function saveFeedback(
    activityId: string,
    feedback: { rpe?: number | null; feeling?: number | null }
  ): Promise<{ ok: boolean; regenerating: boolean; details?: string }> {
    try {
      const data = await postActivityFeedback(activityId, feedback)
      activities.value = data.activities || activities.value
      return { ok: true, regenerating: data.regenerating }
    } catch (err) {
      console.error('[Activities] saveFeedback failed:', err)
      const e = err as { details?: string }
      return { ok: false, regenerating: false, details: e.details }
    }
  }

  return { activities, analysis, loading, loadFromDb, syncFromGarmin, saveFeedback }
})
