<template>
  <li class="activity-item">
    <div class="activity-icon-container">
      <i class="fa-solid fa-bicycle"></i>
    </div>
    <div class="activity-details-main">
      <span class="activity-title">{{ activity.name || 'Cycling Activity' }}</span>
      <span class="activity-meta">{{ meta }}</span>
      <div v-if="hasFeedback" class="act-feedback">
        <span v-if="rpe !== null" class="act-rpe-badge" :class="rpeClass">RPE {{ rpe }}</span>
        <span v-if="feeling !== null" class="act-feeling-badge" :class="feelingEntry.cls" v-html="feelingHtml"></span>
        <span v-if="planEntry?.executionScore != null" class="act-score-badge" :class="scoreClass" :title="planEntry.executionNote || ''">
          <i class="fa-solid fa-brain"></i>
          {{ planEntry.executionScore }}
          <span class="act-score-type">{{ scoreTypeLabel }}</span>
        </span>
      </div>
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
  </li>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { Activity, PlanEntry } from '@/types'
import { toRpe, toFeeling, ACTIVITY_TYPE_LABELS, workoutTypeLabel } from '@/utils'

const props = defineProps<{
  activity: Activity
  planEntry: PlanEntry | null
}>()

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
  3: { label: 'Normal',    icon: 'fa-face-meh',        cls: 'feeling-3' },
  4: { label: 'Good',      icon: 'fa-face-smile',      cls: 'feeling-4' },
  5: { label: 'Strong',    icon: 'fa-face-grin-stars', cls: 'feeling-5' }
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
</script>
