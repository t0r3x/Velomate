import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { getProfile, postProfile } from '@/api/client'
import type { UserHRProfile } from '@/types'

export const useProfileStore = defineStore('profile', () => {
  const profile = ref<UserHRProfile | null>(null)

  const hrLabel = computed(() => {
    if (!profile.value?.lthr || !profile.value?.maxHr) return ''
    return `${profile.value.lthr} / ${profile.value.maxHr}`
  })

  async function fetch() {
    try {
      profile.value = await getProfile()
    } catch { /* ignore */ }
  }

  async function save(data: Partial<UserHRProfile>): Promise<boolean> {
    try {
      await postProfile(data)
      // Merge locally so the HR label updates immediately
      profile.value = { ...(profile.value as UserHRProfile), ...data } as UserHRProfile
      return true
    } catch {
      return false
    }
  }

  function setFromDashboard(p: UserHRProfile | null) {
    if (p) profile.value = p
  }

  return { profile, hrLabel, fetch, save, setFromDashboard }
})
