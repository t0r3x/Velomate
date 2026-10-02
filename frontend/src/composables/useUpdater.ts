import { ref } from 'vue'
import { isElectron, electronAPI } from '@/utils/electron'
import type { UpdateStatus, UpdateCheckResult } from '@/utils/electron'

// Shared singleton — the main process pushes update events once per app
// lifetime, so all consumers of this composable should see the same state.
const status = ref<UpdateStatus | null>(null)
const dismissed = ref(false)
const checking = ref(false)

/**
 * Whether this build can update itself at all. electron-updater only runs in a packaged
 * app, so in dev — and in the browser against a Pi — there is nothing to check. Resolved
 * once here rather than inferred from isElectron(), which is also true in dev.
 */
const updatesSupported = ref(false)

if (isElectron()) {
  electronAPI()?.updatesSupported?.()
    .then((ok) => { updatesSupported.value = ok })
    .catch(() => { updatesSupported.value = false })

  electronAPI()?.onUpdateStatus((s) => {
    status.value = s
    dismissed.value = false // a new status (e.g. downloading → ready) should re-surface the banner
  })
}

export function useUpdater() {
  function dismiss() {
    dismissed.value = true
  }
  function restartAndInstall() {
    electronAPI()?.restartAndInstallUpdate()
  }

  /**
   * Ask the main process to check now. Outside a packaged build there is no updater, so
   * this reports that rather than pretending to have looked.
   */
  async function checkNow(): Promise<UpdateCheckResult> {
    const api = electronAPI()
    if (!api?.checkForUpdates) return { supported: false }
    checking.value = true
    try {
      return await api.checkForUpdates()
    } catch (err) {
      return { supported: true, error: err instanceof Error ? err.message : String(err) }
    } finally {
      checking.value = false
    }
  }

  return { status, dismissed, checking, updatesSupported, dismiss, restartAndInstall, checkNow }
}
