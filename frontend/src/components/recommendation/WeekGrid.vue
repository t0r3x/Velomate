<template>
  <div>
    <div class="week-preview-header">
      <i class="fa-solid fa-calendar-week"></i>
      <span>This Week</span>
      <span class="week-label">{{ weekLabel }}</span>
    </div>
    <div class="week-grid-scroll">
      <div class="week-grid" id="ai-week-grid">
        <WeekDayCell
          v-for="entry in displayPlan"
          :key="entry.date"
          :entry="entry"
          :isToday="entry.date === todayStr"
          :isSelected="entry.date === selectedDate"
          @select="selectEntry"
        />
      </div>

      <!-- Workout detail panel — slides in below the grid on click -->
      <Transition name="wdp-slide">
        <WorkoutDetailPanel
          v-if="selectedEntry"
          :entry="selectedEntry"
          :priority="selectedEntry.date === todayStr ? todayPriority : undefined"
          @skip-today="handleSkipToday"
          @reschedule="handleReschedule"
        />
      </Transition>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { PlanEntry, PlanEntryStatus } from '@/types'
import { isoDate } from '@/utils'
import WeekDayCell       from './WeekDayCell.vue'
import WorkoutDetailPanel from './WorkoutDetailPanel.vue'

const props = defineProps<{ plan: PlanEntry[]; todayPriority?: string }>()
const emit  = defineEmits<{
  reschedule:  [date: string]
  'skip-today': []
}>()

const todayStr = isoDate()

const displayPlan = computed((): PlanEntry[] => {
  // Build Mon–Sun of the current week, filling missing days with synthetic Rest entries
  const today = new Date(todayStr + 'T12:00:00')
  const dow = today.getDay() // 0=Sun … 6=Sat
  const monday = new Date(today)
  monday.setDate(today.getDate() + (dow === 0 ? -6 : 1 - dow))

  const planMap = new Map(props.plan.map(e => [e.date, e]))

  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday)
    d.setDate(monday.getDate() + i)
    const dateStr = isoDate(d)
    return planMap.get(dateStr) ?? {
      date:   dateStr,
      type:   'Rest',
      reason: '',
      status: 'planned' as PlanEntryStatus,
    }
  })
})

const weekLabel = computed(() => {
  if (displayPlan.value.length === 0) return ''
  const fmt = (d: string) =>
    new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  const first = displayPlan.value[0].date
  const last  = displayPlan.value[displayPlan.value.length - 1].date
  return `${fmt(first)} – ${fmt(last)}`
})

// ── Detail panel ──────────────────────────────────────────────────────────────

const selectedDate = ref<string | null>(isoDate())

const selectedEntry = computed(() =>
  selectedDate.value
    ? displayPlan.value.find(e => e.date === selectedDate.value && e.type !== 'Rest') ?? null
    : null
)

function selectEntry(date: string) {
  selectedDate.value = date
}

function handleReschedule(date: string) {
  emit('reschedule', date)
}

function handleSkipToday() {
  emit('skip-today')
}
</script>

<style scoped>
/* Slide-in transition for the detail panel */
.wdp-slide-enter-active,
.wdp-slide-leave-active {
  transition: max-height 0.28s ease, opacity 0.2s ease;
  overflow: hidden;
}
.wdp-slide-enter-from,
.wdp-slide-leave-to {
  max-height: 0;
  opacity: 0;
}
.wdp-slide-enter-to,
.wdp-slide-leave-from {
  max-height: 500px;
  opacity: 1;
}
</style>
