import { ref } from 'vue'
import { isElectron, electronAPI } from '@/utils/electron'
import type { UpdateStatus } from '@/utils/electron'

// Shared singleton — the main process pushes update events once per app
// lifetime, so all consumers of this composable should see the same state.
const status = ref<UpdateStatus | null>(null)
const dismissed = ref(false)

if (isElectron()) {
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
  return { status, dismissed, dismiss, restartAndInstall }
}
