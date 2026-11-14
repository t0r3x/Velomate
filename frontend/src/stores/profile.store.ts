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
      const res = await postProfile(data)
      // The server's copy carries what only it can work out (FTP source, Garmin's FTP);
      // the local merge is the fallback so the HR label updates immediately either way.
      profile.value = res.profile ?? ({ ...(profile.value as UserHRProfile), ...data } as UserHRProfile)
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
