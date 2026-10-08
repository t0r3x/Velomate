<template>
  <li class="activity-item">
    <div class="activity-details-main">
      <span class="activity-title">{{ activity.name || 'Cycling Activity' }}</span>
      <span class="activity-meta">{{ meta }}</span>

      <div v-if="hasFeedback || editing" class="act-feedback">
        <span v-if="rpe !== null" class="act-rpe-badge" :class="rpeClass">RPE {{ rpe }}</span>
        <span v-if="feeling !== null" class="act-feeling-badge" :class="feelingEntry.cls" v-html="feelingHtml"></span>
        <!-- Score and pencil wrap as one unit, so the pencil never ends up alone on a line. -->
        <span class="act-feedback-tail">
          <span v-if="planEntry?.executionScore != null" class="act-score-badge" :class="scoreClass" :title="planEntry.executionNote || ''">
            <i class="fa-solid fa-brain"></i>
            {{ planEntry.executionScore }}
            <span class="act-score-type">{{ scoreTypeLabel }}</span>
          </span>
          <button v-if="!editing" class="act-rate-btn" :title="rateTitle" @click="openEditor">
            <i class="fa-solid fa-pen"></i>
          </button>
        </span>
      </div>

      <!-- No rating yet: the most important signal in the app shouldn't need the watch. -->
      <button v-else class="act-rate-btn act-rate-btn--empty" @click="openEditor">
        <i class="fa-regular fa-face-smile"></i>
        <span>Rate this ride</span>
      </button>

    </div>

    <div class="activity-stats-summary">
      <div class="act-stat act-stat--dist">
        <span class="act-stat-val">{{ activity.distanceKm }} km</span>
        <span class="act-stat-label">Dist</span>
      </div>
      <div class="act-stat act-stat--time">
        <span class="act-stat-val">{{ activity.durationMinutes }} min</span>
        <span class="act-stat-label">Time</span>
      </div>
      <div v-if="activity.averageHr > 0" class="act-stat act-stat--hr">
        <span class="act-stat-val">{{ activity.averageHr }} bpm</span>
        <span class="act-stat-label">Avg HR</span>
      </div>
    </div>

    <!-- A direct child of the item, not of the left column, so it wraps onto its own line
         and spans the full width rather than being squeezed beside the stats. -->
    <div v-if="editing" class="act-rate-editor">
      <div class="act-rate-row">
        <span class="act-rate-label">Effort</span>
        <div
          class="act-rate-slider"
          :class="{ 'is-unset': draftRpe === null }"
          :title="draftRpe !== null ? `${draftRpe} · ${RPE_HINTS[draftRpe]}` : 'Not rated'"
        >
          <input
            v-model.number="rpeSlider"
            class="act-rate-range"
            type="range"
            min="1"
            max="10"
            step="1"
            aria-label="Perceived effort, 1 to 10"
          />
          <div class="act-rate-ticks" aria-hidden="true">
            <span
              v-for="n in 10"
              :key="`tick-${n}`"
              class="act-rate-tick"
              :class="{ 'is-current': draftRpe === n }"
            >{{ n }}</span>
          </div>
        </div>
      </div>

      <div class="act-rate-row">
        <span class="act-rate-label">Feeling</span>
        <div class="act-rate-scale">
          <button
            v-for="n in 5"
            :key="`feel-${n}`"
            class="act-rate-chip act-rate-chip--face"
            :class="{ 'is-selected': draftFeeling === n }"
            :title="FEELING_MAP[n].label"
            @click="draftFeeling = draftFeeling === n ? null : n"
          ><i class="fa-regular" :class="FEELING_MAP[n].icon"></i></button>
        </div>
      </div>

      <div class="act-rate-actions">
        <button class="btn btn-secondary btn-sm" :disabled="saving" @click="editing = false">Cancel</button>
        <button class="btn btn-primary btn-sm" :disabled="saving || !hasDraft" @click="save">
          <span>{{ saving ? 'Saving…' : 'Save' }}</span>
          <i v-if="saving" class="fa-solid fa-spinner fa-spin"></i>
        </button>
      </div>
    </div>
  </li>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Activity, PlanEntry } from '@/types'
import { toRpe, toFeeling, ACTIVITY_TYPE_LABELS, workoutTypeLabel } from '@/utils'
import { useActivitiesStore } from '@/stores/activities.store'
import { useToast } from '@/composables/useToast'

const props = defineProps<{
  activity: Activity
  planEntry: PlanEntry | null
}>()

/** Fires after a rating was accepted by Garmin; `regenerating` says whether AI re-evaluation started. */
const emit = defineEmits<{ rated: [regenerating: boolean] }>()

const activitiesStore = useActivitiesStore()
const { show } = useToast()

const meta = computed(() => {
  const dateFormatted = new Date(props.activity.startTime).toLocaleDateString('en-GB', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  })
  const rawType = (props.activity.type || '').toLowerCase()
  const typeLabel = ACTIVITY_TYPE_LABELS[rawType]
    ?? (props.activity.type
      ? props.activity.type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
      : 'Cycling')
  return `${dateFormatted} • ${typeLabel}`
})

const rpe = computed(() =>
  props.activity.perceivedExertion != null ? toRpe(props.activity.perceivedExertion) : null
)

const rpeClass = computed(() => {
  const r = rpe.value
  if (r == null) return ''
  return r <= 3 ? 'rpe-easy' : r <= 5 ? 'rpe-moderate' : r <= 7 ? 'rpe-hard' : 'rpe-max'
})

const feeling = computed(() =>
  props.activity.feelingAfterExercise != null ? toFeeling(props.activity.feelingAfterExercise) : null
)

const FEELING_MAP: Record<number, { label: string; icon: string; cls: string }> = {
  1: { label: 'Exhausted', icon: 'fa-face-dizzy',      cls: 'feeling-1' },
  2: { label: 'Tired',     icon: 'fa-face-tired',      cls: 'feeling-2' },
  3: { label: 'Normal',    icon: 'fa-face-smile',      cls: 'feeling-3' },
  4: { label: 'Good',      icon: 'fa-face-grin',       cls: 'feeling-4' },
  5: { label: 'Strong',    icon: 'fa-face-grin-stars', cls: 'feeling-5' }
}

/** Borg anchors, so the numbers mean the same thing here as on the watch. */
const RPE_HINTS: Record<number, string> = {
  1: 'Very easy',  2: 'Easy',       3: 'Light',      4: 'Comfortable', 5: 'Moderate',
  6: 'Somewhat hard', 7: 'Hard',    8: 'Very hard',  9: 'Extremely hard', 10: 'Maximal'
}

const feelingEntry = computed(() => {
  const f = feeling.value
  return f != null ? (FEELING_MAP[f] ?? FEELING_MAP[3]) : FEELING_MAP[3]
})

const feelingHtml = computed(() =>
  `<i class="fa-regular ${feelingEntry.value.icon}"></i> ${feelingEntry.value.label}`
)

const scoreClass = computed(() => {
  const score = props.planEntry?.executionScore ?? null
  if (score == null) return 'act-score-badge'
  return `act-score-badge ${score >= 80 ? 'score-great' : score >= 60 ? 'score-ok' : 'score-poor'}`
})

const scoreTypeLabel = computed(() =>
  props.planEntry ? (workoutTypeLabel[props.planEntry.type] || props.planEntry.type) : ''
)

const hasFeedback = computed(() =>
  rpe.value !== null || feeling.value !== null || (props.planEntry?.executionScore != null)
)

// ── Rating editor ────────────────────────────────────────────────────────────

const editing     = ref(false)
const saving      = ref(false)
const draftRpe     = ref<number | null>(null)
const draftFeeling = ref<number | null>(null)

const rateTitle = computed(() =>
  rpe.value !== null || feeling.value !== null ? 'Change your rating' : 'Rate this ride'
)

const hasDraft = computed(() => draftRpe.value !== null || draftFeeling.value !== null)

/**
 * A range input cannot represent "not rated", so an unrated ride parks the handle in the
 * middle while the track stays muted and the readout says so. Touching it is what commits
 * a value — which keeps "no opinion" distinguishable from "I rated this a 5".
 */
const rpeSlider = computed({
  get: () => draftRpe.value ?? 5,
  set: (v: number) => { draftRpe.value = v }
})

function openEditor() {
  draftRpe.value     = rpe.value
  draftFeeling.value = feeling.value
  editing.value      = true
}

async function save() {
  saving.value = true
  const result = await activitiesStore.saveFeedback(String(props.activity.activityId), {
    rpe:     draftRpe.value,
    feeling: draftFeeling.value
  })
  saving.value = false

  if (!result.ok) {
    // The backend writes Garmin first, so a failure means nothing was stored anywhere —
    // keep the editor open rather than pretending the rating landed.
    show('error', 'Could not save rating', result.details || 'Garmin did not accept the update.')
    return
  }

  editing.value = false
  show('success', 'Rating saved', 'Synced to Garmin Connect.')
  emit('rated', result.regenerating)
}
</script>
