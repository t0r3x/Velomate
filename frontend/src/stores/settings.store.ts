import { defineStore } from 'pinia'
import { ref } from 'vue'
import {
  getGeminiKeyStatus,
  postGeminiKey,
  deleteGeminiKey,
  postGeminiModel,
  postPreferredDays,
  postInactivityPauseDays,
  postInstantScoreOnNewActivity,
  postFreeTrainingMode,
  postSetupComplete
} from '@/api/client'

export const useSettingsStore = defineStore('settings', () => {
  const loaded              = ref(false)
  const geminiConfigured    = ref(false)
  const setupComplete       = ref(false)
  const maskedKey           = ref<string | null>(null)
  const preferredLongRideDays = ref<string[]>([])
  const geminiModel         = ref('gemini-3.6-flash')
  const inactivityPauseDays = ref(14)
  const instantScoreOnNewActivity = ref(true)
  const freeTrainingMode          = ref(false)

  async function init() {
    if (loaded.value) return
    try {
      const data = await getGeminiKeyStatus()
      geminiConfigured.value      = data.hasKey
      setupComplete.value         = data.setupComplete
      maskedKey.value             = data.hasKey ? data.maskedKey : null
      preferredLongRideDays.value = Array.isArray(data.preferredLongRideDays) ? data.preferredLongRideDays : []
      geminiModel.value           = data.geminiModel || 'gemini-3.6-flash'
      inactivityPauseDays.value   = data.inactivityPauseDays ?? 14
      instantScoreOnNewActivity.value = data.instantScoreOnNewActivity ?? true
      freeTrainingMode.value      = data.freeTrainingMode ?? false
    } catch (err) {
      console.warn('[Settings] init failed (backend offline?):', err)
    } finally {
      loaded.value = true
    }
  }

  /** Reload settings without resetting the loaded flag (used after save). */
  async function reload() {
    try {
      const data = await getGeminiKeyStatus()
      geminiConfigured.value      = data.hasKey
      setupComplete.value         = data.setupComplete
      maskedKey.value             = data.hasKey ? data.maskedKey : null
      preferredLongRideDays.value = Array.isArray(data.preferredLongRideDays) ? data.preferredLongRideDays : []
      geminiModel.value           = data.geminiModel || 'gemini-3.6-flash'
      inactivityPauseDays.value   = data.inactivityPauseDays ?? 14
      instantScoreOnNewActivity.value = data.instantScoreOnNewActivity ?? true
      freeTrainingMode.value      = data.freeTrainingMode ?? false
    } catch (err) {
      console.warn('[Settings] reload failed:', err)
    }
  }

  async function saveAll(apiKey: string, model: string): Promise<boolean> {
    try {
      await postGeminiModel(model)
      if (apiKey.trim()) {
        await postGeminiKey(apiKey.trim())
      }
      await reload()
      return true
    } catch (err) {
      console.error('[Settings] saveAll failed:', err)
      return false
    }
  }

  async function saveInactivityPauseDays(days: number): Promise<boolean> {
    try {
      await postInactivityPauseDays(days)
      inactivityPauseDays.value = days
      return true
    } catch (err) {
      console.error('[Settings] saveInactivityPauseDays failed:', err)
      return false
    }
  }

  async function saveInstantScoreOnNewActivity(enabled: boolean): Promise<boolean> {
    try {
      await postInstantScoreOnNewActivity(enabled)
      instantScoreOnNewActivity.value = enabled
      return true
    } catch (err) {
      console.error('[Settings] saveInstantScoreOnNewActivity failed:', err)
      return false
    }
  }

  /**
   * Switch between the 14-day AI plan and free training mode. The backend keeps both
   * artefacts side by side, so flipping this never destroys the other mode's data.
   */
  async function saveFreeTrainingMode(enabled: boolean): Promise<boolean> {
    try {
      await postFreeTrainingMode(enabled)
      freeTrainingMode.value = enabled
      return true
    } catch (err) {
      console.error('[Settings] saveFreeTrainingMode failed:', err)
      return false
    }
  }

  async function disconnectGemini(): Promise<boolean> {
    try {
      await deleteGeminiKey()
      geminiConfigured.value = false
      maskedKey.value        = null
      return true
    } catch (err) {
      console.error('[Settings] disconnectGemini failed:', err)
      return false
    }
  }

  async function savePreferredDays(days: string[]): Promise<boolean> {
    try {
      await postPreferredDays(days)
      preferredLongRideDays.value = days
      return true
    } catch (err) {
      console.error('[Settings] savePreferredDays failed:', err)
      return false
    }
  }

  async function markSetupComplete() {
    try {
      await postSetupComplete()
      setupComplete.value = true
    } catch (err) {
      console.warn('[Settings] markSetupComplete failed:', err)
    }
  }

  return {
    loaded,
    geminiConfigured,
    setupComplete,
    maskedKey,
    preferredLongRideDays,
    geminiModel,
    inactivityPauseDays,
    instantScoreOnNewActivity,
    freeTrainingMode,
    init,
    reload,
    saveAll,
    disconnectGemini,
    savePreferredDays,
    saveInactivityPauseDays,
    saveInstantScoreOnNewActivity,
    saveFreeTrainingMode,
    markSetupComplete
  }
})
