import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { getCheckin, postCheckin, deleteCheckin } from '@/api/client'
import type { DailyCheckin, ReplacedSyncedWorkout } from '@/types'

/**
 * How the athlete feels today, said without having to ride.
 *
 * Every other signal in the app is attached to an activity, which leaves rest days — and the
 * bad night before one — completely silent. This is the one input that works on a day off.
 */
interface CheckinWriteResult {
  ok: boolean
  regenerating: boolean
  /** Non-null when this write displaced a workout already synced to Garmin. */
  replaced: ReplacedSyncedWorkout | null
}

export const useCheckinStore = defineStore('checkin', () => {
  const today   = ref<DailyCheckin | null>(null)
  const history = ref<DailyCheckin[]>([])
  const loaded  = ref(false)
  const saving  = ref(false)

  /** True once today's answer is in — drives "asked" vs "answered" in the card. */
  const answeredToday = computed(() => today.value !== null)


  async function fetch() {
    try {
      const data = await getCheckin()
      today.value   = data.today
      history.value = data.history || []
    } catch (err) {
      console.warn('[Check-in] fetch failed:', err)
    } finally {
      loaded.value = true
    }
  }

  /** Record (or correct) today's answer. Returns whether an AI re-evaluation started. */
  async function save(feeling: number, note?: string): Promise<CheckinWriteResult> {
    saving.value = true
    try {
      const data = await postCheckin(feeling, note)
      today.value   = data.today
      history.value = data.history || []
      return { ok: true, regenerating: data.regenerating, replaced: data.replacedSyncedWorkout }
    } catch (err) {
      console.error('[Check-in] save failed:', err)
      return { ok: false, regenerating: false, replaced: null }
    } finally {
      saving.value = false
    }
  }

  /** Remove today's answer entirely — back to an unanswered day. */
  async function clear(): Promise<CheckinWriteResult> {
    saving.value = true
    try {
      const data = await deleteCheckin()
      today.value   = null
      history.value = data.history || []
      return { ok: true, regenerating: data.regenerating, replaced: data.replacedSyncedWorkout }
    } catch (err) {
      console.error('[Check-in] clear failed:', err)
      return { ok: false, regenerating: false, replaced: null }
    } finally {
      saving.value = false
    }
  }

  return { today, history, loaded, saving, answeredToday, fetch, save, clear }
})
