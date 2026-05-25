import { defineStore } from 'pinia'
import { ref } from 'vue'
import {
  getGeminiKeyStatus,
  postGeminiKey,
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
    } catch {
      // Backend offline — don't block routing
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
    } catch { /* ignore */ }
  }

  async function saveAll(apiKey: string, days: string[], model: string): Promise<boolean> {
    try {
      await Promise.all([
        postPreferredDays(days),
        postGeminiModel(model)
      ])
      if (apiKey.trim()) {
        await postGeminiKey(apiKey.trim())
      }
      await reload()
      return true
    } catch {
      return false
    }
  }

  async function markSetupComplete() {
    try {
      await postSetupComplete()
      setupComplete.value = true
    } catch { /* ignore */ }
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
    markSetupComplete
  }
})
