import { ref } from 'vue'

// Module-scope singleton — returns the typed reason string or null if cancelled
const visible = ref(false)
let resolveFn: ((reason: string | null) => void) | null = null

export function usePauseDialog() {
  function promptForReason(): Promise<string | null> {
    visible.value = true
    return new Promise(resolve => { resolveFn = resolve })
  }

  function _accept(reason: string) {
    visible.value = false
    resolveFn?.(reason)
    resolveFn = null
  }

  function _cancel() {
    visible.value = false
    resolveFn?.(null)
    resolveFn = null
  }

  return { visible, promptForReason, _accept, _cancel }
}
