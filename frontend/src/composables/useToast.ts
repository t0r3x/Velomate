import { ref } from 'vue'

export type ToastType = 'success' | 'error' | 'info' | 'warn'

export interface ToastItem {
  id: number
  type: ToastType
  title: string
  msg: string
  removing: boolean
}

// Module-scope singleton — all components share the same toast list
const toasts = ref<ToastItem[]>([])
let _nextId = 0

export function useToast() {
  function show(type: ToastType, title: string, msg = '', duration = 4000) {
    const id = _nextId++
    toasts.value.push({ id, type, title, msg, removing: false })

    setTimeout(() => {
      dismiss(id)
    }, duration)
  }

  function dismiss(id: number) {
    const item = toasts.value.find(t => t.id === id)
    if (!item) return
    item.removing = true
    setTimeout(() => {
      toasts.value = toasts.value.filter(t => t.id !== id)
    }, 400) // matches CSS animation duration
  }

  return { toasts, show, dismiss }
}
