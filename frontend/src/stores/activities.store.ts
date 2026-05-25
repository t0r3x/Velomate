import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getDashboard, postActivitiesRefresh } from '@/api/client'
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
    } catch { /* ignore */ }
  }

  /** Full Garmin sync: fetches new rides, updates DB, re-runs analysis. */
  async function syncFromGarmin(): Promise<{ newCount: number }> {
    loading.value = true
    try {
      const data = await postActivitiesRefresh()
      activities.value = data.activities || []
      analysis.value   = data.analysis
      if (data.currentProfile) {
        useProfileStore().setFromDashboard(data.currentProfile)
      }
      return { newCount: data.newCount || 0 }
    } finally {
      loading.value = false
    }
  }

  return { activities, analysis, loading, loadFromDb, syncFromGarmin }
})
