import { ref } from 'vue'

export interface ConfirmOptions {
  title:         string
  message:       string
  confirmLabel?: string   // default: 'Confirm'
  cancelLabel?:  string   // default: 'Cancel'
  danger?:       boolean  // red confirm button
}

// Module-scope singleton — one dialog at a time, accessible from anywhere
const visible = ref(false)
const options = ref<ConfirmOptions>({ title: '', message: '' })
let resolveFn: ((value: boolean) => void) | null = null

export function useConfirm() {
  function confirm(opts: ConfirmOptions): Promise<boolean> {
    options.value = opts
    visible.value = true
    return new Promise(resolve => { resolveFn = resolve })
  }

  function _accept() {
    visible.value = false
    resolveFn?.(true)
    resolveFn = null
  }

  function _cancel() {
    visible.value = false
    resolveFn?.(false)
    resolveFn = null
  }

  return { visible, options, confirm, _accept, _cancel }
}
