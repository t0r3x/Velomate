<template>
  <div
    class="week-day-cell"
    :class="[
      isRest ? 'rest' : `has-workout wt-${entry.type.toLowerCase()}`,
      { 'is-today': isToday, 'is-completed': isCompleted, 'is-skipped': isSkipped }
    ]"
    :title="entry.reason || ''"
  >
    <div class="wdc-day">
      <span class="wdc-day-label">{{ dayLabel }}</span>
      <span class="wdc-date">{{ dayOfMonth }}</span>
    </div>

    <!-- Rest day -->
    <template v-if="isRest">
      <div class="wdc-rest">
        <i class="fa-solid fa-bed"></i> Rest
      </div>
    </template>

    <!-- Workout day -->
    <template v-else>
      <div class="wdc-workout-chip">
        <i class="fa-solid" :class="typeIcon"></i>
        <span class="wdc-workout-label">{{ typeLabel }}</span>
      </div>
      <div class="wdc-duration">{{ durationText }}</div>

      <!-- Status badge -->
      <div v-if="isCompleted" class="wdc-scheduled-badge" :class="scoreBadgeClass" :title="entry.executionNote || ''">
        <i class="fa-solid fa-circle-check"></i>
        {{ entry.executionScore != null ? entry.executionScore : 'Done' }}
      </div>
      <div v-else-if="isSkipped" class="wdc-scheduled-badge wdc-badge-skipped">
        <i class="fa-solid fa-forward-step"></i> Skipped
      </div>

      <!-- Move to today button — only on future planned entries -->
      <button
        v-if="canMove"
        class="btn-move-today"
        title="Move to today"
        @click.stop="emit('reschedule', entry.date)"
      >
        <i class="fa-solid fa-calendar-day"></i>
      </button>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { PlanEntry } from '@/types'
import { workoutTypeIcon, workoutTypeLabel, DAY_NAMES, isoDate } from '@/utils'

const props = defineProps<{ entry: PlanEntry; isToday: boolean }>()
const emit  = defineEmits<{ reschedule: [date: string] }>()

const d = computed(() => new Date(props.entry.date + 'T12:00:00'))
const dayLabel   = computed(() => DAY_NAMES[d.value.getDay()])
const dayOfMonth = computed(() => d.value.getDate())

const isRest      = computed(() => props.entry.type === 'Rest')
const isCompleted = computed(() => props.entry.status === 'completed' || props.entry.status === 'completed-partial' || props.entry.status === 'completed-mismatch')
const isSkipped   = computed(() => props.entry.status === 'skipped' || props.entry.status === 'auto-skipped')

const typeIcon  = computed(() => workoutTypeIcon[props.entry.type]  ?? 'fa-dumbbell')
const typeLabel = computed(() => workoutTypeLabel[props.entry.type] ?? props.entry.type)

const durationText = computed(() =>
  props.entry.structure?.totalMinutes ? `${props.entry.structure.totalMinutes} min` : ''
)

const scoreBadgeClass = computed(() => {
  const score = props.entry.executionScore
  if (score == null) return 'wdc-badge-done'
  return `wdc-badge-score ${score >= 80 ? 'wdc-badge-score-great' : score >= 60 ? 'wdc-badge-score-ok' : 'wdc-badge-score-poor'}`
})

const canMove = computed(() =>
  !props.isToday &&
  props.entry.status === 'planned' &&
  props.entry.date > isoDate()
)
</script>
