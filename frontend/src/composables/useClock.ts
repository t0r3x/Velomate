import { ref, computed } from 'vue'
import { isoDate } from '@/utils'

/**
 * A shared, reactive clock for anything that depends on "now" or "today".
 *
 * The packaged app is a desktop window that stays open for days. Values captured once at
 * setup (`const today = isoDate()`) went stale after midnight: the week grid lost its "today"
 * marker and its open day, the Trend chart divided the current week by the wrong number of
 * days, and the header's stale-sync warning could never switch on. One timer for the whole
 * app, ticking once a minute, is enough for all of them.
 */
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null

export function useClock() {
  if (!timer) timer = setInterval(() => { now.value = Date.now() }, 60_000)
  const today = computed(() => isoDate(new Date(now.value)))
  return { now, today }
}
