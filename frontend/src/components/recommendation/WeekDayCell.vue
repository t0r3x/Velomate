<template>
  <div
    class="week-day-cell"
    :class="[
      isPastPlaceholder ? 'past-placeholder' : isPlaceholder ? 'placeholder' : isRest ? 'rest' : `has-workout wt-${entry.type.toLowerCase()}`,
      {
        'is-today':     isToday,
        'is-completed': isCompleted,
        'is-skipped':   isSkipped,
        'is-selected':  isSelected,
        'is-clickable': true,
      }
    ]"
    @click="emit('select', entry.date)"
  >
    <div class="wdc-day">
      <span class="wdc-day-label">{{ dayLabel }}</span>
      <span class="wdc-date">{{ dayOfMonth }}</span>
    </div>

    <!-- Before today, with no history — refreshing can never fill this in, so it's a
         quiet "no data" note, not an actionable warning -->
    <template v-if="isPastPlaceholder">
      <div class="wdc-placeholder wdc-past-placeholder">
        <i class="fa-solid fa-minus"></i> No data
      </div>
    </template>

    <!-- Not covered by the backend's plan yet, but still ahead of today — refreshing
         can genuinely close this gap -->
    <template v-else-if="isPlaceholder">
      <div class="wdc-placeholder">
        <i class="fa-solid fa-hourglass-half"></i> Not planned yet
      </div>
    </template>

    <!-- Rest day -->
    <template v-else-if="isRest">
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
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { PlanEntry } from '@/types'
import { workoutTypeIcon, workoutTypeLabel, DAY_NAMES } from '@/utils'

const props = defineProps<{ entry: PlanEntry; isToday: boolean; isSelected?: boolean }>()
const emit  = defineEmits<{ select: [date: string] }>()

const d          = computed(() => new Date(props.entry.date + 'T12:00:00'))
const dayLabel   = computed(() => DAY_NAMES[d.value.getDay()])
const dayOfMonth = computed(() => d.value.getDate())

const isPlaceholder     = computed(() => !!props.entry.isPlaceholder)
const isPastPlaceholder = computed(() => !!props.entry.isPastPlaceholder)
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
</script>

<style scoped>
.week-day-cell.is-clickable {
  cursor: pointer;
}

.week-day-cell.is-selected {
  background: rgba(var(--primary-rgb), 0.14) !important;
  outline: 1px solid rgba(var(--primary-rgb), 0.4);
  outline-offset: -1px;
}
</style>
