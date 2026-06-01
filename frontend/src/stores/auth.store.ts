import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getStatus, postLogin, postMfa, postLogout } from '@/api/client'

export const useAuthStore = defineStore('auth', () => {
  const isLoggedIn = ref(false)
  const loaded     = ref(false)
  const showMfa    = ref(false)

  let _pollInterval: ReturnType<typeof setInterval> | null = null

  async function init() {
    if (loaded.value) return
    try {
      const data = await getStatus()
      isLoggedIn.value = data.loggedIn
    } catch (err) {
      console.warn('[Auth] status check failed during init:', err)
      isLoggedIn.value = false
    } finally {
      loaded.value = true
    }
  }

  async function refresh() {
    try {
      const data = await getStatus()
      isLoggedIn.value = data.loggedIn
    } catch (err) {
      console.warn('[Auth] status poll failed:', err)
      isLoggedIn.value = false
    }
  }

  async function login(username: string, password: string): Promise<'ok' | 'mfa' | 'error'> {
    try {
      const data = await postLogin(username, password)
      if (data.mfaRequired) {
        showMfa.value = true
        return 'mfa'
      }
      isLoggedIn.value = true
      showMfa.value    = false
      return 'ok'
    } catch (err) {
      console.error('[Auth] login failed:', err)
      return 'error'
    }
  }

  async function submitMfa(code: string): Promise<boolean> {
    try {
      await postMfa(code)
      isLoggedIn.value = true
      showMfa.value    = false
      return true
    } catch (err) {
      console.error('[Auth] MFA submit failed:', err)
      return false
    }
  }

  function logout() {
    isLoggedIn.value = false
    showMfa.value    = false
    postLogout().catch(() => { /* non-critical */ })
  }

  function startPolling() {
    if (_pollInterval) return
    _pollInterval = setInterval(refresh, 30_000)
  }

  function stopPolling() {
    if (_pollInterval) {
      clearInterval(_pollInterval)
      _pollInterval = null
    }
  }

  return { isLoggedIn, loaded, showMfa, init, refresh, login, submitMfa, logout, startPolling, stopPolling }
})
