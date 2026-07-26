<template>
  <div>
    <div class="week-preview-header">
      <i class="fa-solid fa-calendar-week"></i>
      <span>{{ title }}</span>
      <span class="week-label">{{ weekLabel }}</span>
    </div>
    <p v-if="coverageNote" class="week-coverage-note">
      <i class="fa-solid fa-circle-info"></i> {{ coverageNote }}
    </p>
    <div class="week-grid-scroll">
      <div class="week-grid">
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
          @skip="handleSkip"
          @reschedule="handleReschedule"
        />
      </Transition>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { PlanEntry } from '@/types'
import { isoDate, buildWeekWindow, describeCoverageGaps } from '@/utils'
import WeekDayCell       from './WeekDayCell.vue'
import WorkoutDetailPanel from './WorkoutDetailPanel.vue'

const props = defineProps<{
  plan: PlanEntry[]
  todayPriority?: string
  /** Days to shift the displayed 7-day window forward from today (e.g. 7 for "next week"). */
  startOffset?: number
  title: string
}>()
const emit  = defineEmits<{
  reschedule: [date: string]
  skip:       [date: string]
}>()

const todayStr = isoDate()

// Show the actual rolling 7-day window the backend generates (today+offset .. today+offset+6),
// filling any missing day with a placeholder — never fabricate a real AI-planned rest day for
// a date the backend hasn't covered. This must NOT be a fixed Mon–Sun calendar week — anchoring
// to today means the next 7 days are always shown in full detail regardless of what weekday it
// is (a fixed calendar week would show fewer of the imminent days once today is past Monday).
const displayPlan = computed((): PlanEntry[] => buildWeekWindow(props.plan, props.startOffset ?? 0))

// Days shown in the grid that the backend hasn't actually planned yet — surfaced
// explicitly so a coverage gap never looks like a real AI-planned rest day.
const coverageNote = computed(() => describeCoverageGaps(displayPlan.value))

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
    ? displayPlan.value.find(e => e.date === selectedDate.value) ?? null
    : null
)

function selectEntry(date: string) {
  selectedDate.value = date
}

function handleReschedule(date: string) {
  emit('reschedule', date)
}

function handleSkip(date: string) {
  emit('skip', date)
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
