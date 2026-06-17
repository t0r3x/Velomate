import { ref } from 'vue'
import type { PlanEntry } from '@/types'

export interface MoveDayOptions {
  entry: PlanEntry
  plan:  PlanEntry[]
}

const visible = ref(false)
const options = ref<MoveDayOptions | null>(null)
let resolveFn: ((toDate: string | null) => void) | null = null

export function useMoveDayDialog() {
  function pickDay(entry: PlanEntry, plan: PlanEntry[]): Promise<string | null> {
    options.value = { entry, plan }
    visible.value = true
    return new Promise(resolve => { resolveFn = resolve })
  }

  function _pick(toDate: string) {
    visible.value = false
    resolveFn?.(toDate)
    resolveFn = null
  }

  function _cancel() {
    visible.value = false
    resolveFn?.(null)
    resolveFn = null
  }

  return { visible, options, pickDay, _pick, _cancel }
}
