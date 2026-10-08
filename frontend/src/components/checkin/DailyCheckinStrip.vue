<template>
  <div class="checkin-block">
    <!-- Unanswered, or reopened via Change. Nothing is written until Save is pressed:
         picking a face is a selection, not a commitment, so a note can still be typed. -->
    <template v-if="!store.answeredToday || changing">
      <!-- One row, in the order the athlete fills it: question, rating, note, save. -->
      <div class="checkin-row">
        <span class="checkin-label">How are you today?</span>
        <div class="checkin-faces">
          <button
            v-for="n in 5"
            :key="`feel-${n}`"
            type="button"
            class="checkin-face"
            :class="{ 'is-selected': draftFeeling === n }"
            :title="FEELING_MAP[n].label"
            :aria-label="FEELING_MAP[n].label"
            :aria-pressed="draftFeeling === n"
            @click="draftFeeling = n"
          ><i class="fa-regular" :class="FEELING_MAP[n].icon"></i></button>
        </div>
        <input
          v-model="draftNote"
          class="checkin-note"
          type="text"
          maxlength="200"
          placeholder="Add a note (optional) — slept badly, sore legs, ran yesterday…"
          @keyup.enter="save"
        />
        <button v-if="changing" type="button" class="btn btn-secondary btn-sm" :disabled="store.saving" @click="cancel">
          Cancel
        </button>
        <button type="button" class="btn btn-primary btn-sm" :disabled="store.saving || draftFeeling === null" @click="save">
          <span>{{ store.saving ? 'Saving…' : 'Save' }}</span>
          <i v-if="store.saving" class="fa-solid fa-spinner fa-spin"></i>
        </button>
      </div>
    </template>

    <!-- Answered: one quiet line. -->
    <div v-else class="checkin-row">
      <span class="checkin-answer">
        <i class="fa-regular" :class="FEELING_MAP[store.today!.feeling].icon"></i>
        {{ FEELING_MAP[store.today!.feeling].label }} today
      </span>
      <span v-if="store.today!.note" class="checkin-answer-note">“{{ store.today!.note }}”</span>
      <div class="checkin-links">
        <button type="button" class="checkin-link" :disabled="store.saving" @click="openEditor">Change</button>
        <button
          type="button"
          class="checkin-link"
          :disabled="store.saving"
          title="Remove today's answer and re-plan as if you never entered it"
          @click="clear"
        >Clear</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useCheckinStore } from '@/stores/checkin.store'
import { useRecommendationStore } from '@/stores/recommendation.store'
import { useFreeTrainingStore } from '@/stores/freeTraining.store'
import { useSettingsStore } from '@/stores/settings.store'
import { useToast } from '@/composables/useToast'
import type { ReplacedSyncedWorkout } from '@/types'

const store               = useCheckinStore()
const recommendationStore = useRecommendationStore()
const freeTrainingStore   = useFreeTrainingStore()
const settingsStore       = useSettingsStore()
const { show }            = useToast()

/** Same vocabulary as the post-ride feeling badges, so 1-5 means one thing across the app. */
const FEELING_MAP: Record<number, { label: string; icon: string }> = {
  1: { label: 'Exhausted', icon: 'fa-face-dizzy' },
  2: { label: 'Tired',     icon: 'fa-face-tired' },
  3: { label: 'Normal',    icon: 'fa-face-smile' },
  4: { label: 'Good',      icon: 'fa-face-grin' },
  5: { label: 'Strong',    icon: 'fa-face-grin-stars' }
}

/** Reopens the editor without touching stored state — the saved answer stays saved. */
const changing     = ref(false)
const draftFeeling = ref<number | null>(null)
const draftNote    = ref('')

function openEditor() {
  draftFeeling.value = store.today?.feeling ?? null
  draftNote.value    = store.today?.note ?? ''
  changing.value     = true
}

function cancel() {
  changing.value = false
}

async function save() {
  if (draftFeeling.value === null || store.saving) return

  const result = await store.save(draftFeeling.value, draftNote.value.trim() || undefined)
  if (!result.ok) {
    // Keep the editor open on failure rather than collapsing back to the previous answer
    // as if the new one had landed.
    show('error', 'Could not save', 'Your check-in was not saved.')
    return
  }

  changing.value = false
  afterWrite(result, 'Your plan is being updated to match how you feel.')
}

/**
 * Drop today's answer entirely, so the next plan is generated as if it was never entered.
 * Deliberately not the same as rating yourself Normal — that is still an answer the prompt
 * weighs; a cleared day is one the model is told to read nothing into.
 */
async function clear() {
  if (store.saving) return

  const result = await store.clear()
  if (!result.ok) {
    show('error', 'Could not clear', 'Your check-in was not cleared.')
    return
  }

  draftFeeling.value = null
  draftNote.value    = ''
  changing.value     = false
  afterWrite(result, 'Your plan is being regenerated without your check-in.')
}

/**
 * The backend only re-plans when something actually changed, so `regenerating` is the honest
 * signal for whether there is anything to wait for.
 */
function afterWrite(result: { regenerating: boolean; replaced: ReplacedSyncedWorkout | null }, message: string) {
  const { regenerating, replaced } = result

  // A replaced suggestion that was already on the watch leaves a workout behind in Garmin.
  // Only the athlete can remove it, so saying nothing would quietly orphan it.
  if (replaced) {
    const when = new Date(replaced.date + 'T12:00:00')
      .toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
    show('warn', 'Synced workout replaced',
      `Your ${replaced.type} workout scheduled for ${when} is still on your Garmin calendar. Remove it there if you are not going to ride it.`)
  }

  if (!regenerating) return
  show('info', 'Adjusting your plan', message)
  if (settingsStore.freeTrainingMode) {
    freeTrainingStore.pollForUpdate(freeTrainingStore.suggestion?.generatedAt, 20, true)
  } else {
    recommendationStore.pollForUpdate(recommendationStore.recommendation?.generatedAt, 20, true)
  }
}

onMounted(() => { store.fetch() })
</script>
