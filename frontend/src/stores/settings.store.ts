import { defineStore } from 'pinia'
import { ref } from 'vue'
import {
  getGeminiKeyStatus,
  postGeminiKey,
  deleteGeminiKey,
  postGeminiModel,
  postPreferredDays,
  postSetupComplete
} from '@/api/client'

export const useSettingsStore = defineStore('settings', () => {
  const loaded              = ref(false)
  const geminiConfigured    = ref(false)
  const setupComplete       = ref(false)
  const maskedKey           = ref<string | null>(null)
  const preferredLongRideDays = ref<string[]>([])
  const geminiModel         = ref('gemini-3.5-flash')

  async function init() {
    if (loaded.value) return
    try {
      const data = await getGeminiKeyStatus()
      geminiConfigured.value      = data.hasKey
      setupComplete.value         = data.setupComplete
      maskedKey.value             = data.hasKey ? data.maskedKey : null
      preferredLongRideDays.value = Array.isArray(data.preferredLongRideDays) ? data.preferredLongRideDays : []
      geminiModel.value           = data.geminiModel || 'gemini-3.5-flash'
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
      geminiModel.value           = data.geminiModel || 'gemini-3.5-flash'
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
    init,
    reload,
    saveAll,
    disconnectGemini,
    savePreferredDays,
    markSetupComplete
  }
})
