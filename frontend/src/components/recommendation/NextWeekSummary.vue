<template>
  <div class="ai-week-section">
    <div class="week-preview-header">
      <i class="fa-solid fa-calendar-week"></i>
      <span>Next Week</span>
      <span class="week-label">{{ weekLabel }}</span>
    </div>
    <p class="ai-next-week-summary">{{ summary }}</p>
    <div v-if="sessions.length" class="ai-next-week-chips">
      <span
        v-for="s in sessions"
        :key="s.date"
        class="ai-workout-chip ai-next-week-chip"
        :class="`wt-${s.type.toLowerCase()}`"
      >
        <i class="fa-solid" :class="typeIcon(s.type)"></i>
        <span class="nw-type">{{ typeLabel(s.type) }}</span>
        <span class="nw-day">{{ dayLabel(s.date) }}</span>
      </span>
    </div>
    <p v-if="nextWeekFocus" class="ai-next-week-emphasis">{{ nextWeekFocus }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { PlanEntry } from '@/types'
import { workoutTypeIcon, workoutTypeLabel, DAY_NAMES, buildWeekWindow } from '@/utils'

const props = defineProps<{ plan: PlanEntry[]; startOffset: number; nextWeekFocus: string | null }>()

// Real second-week slice of the plan — no separate AI-guessed overview anymore.
const weekEntries = computed((): PlanEntry[] => buildWeekWindow(props.plan, props.startOffset))

const sessions = computed(() => weekEntries.value.filter(e => e.type !== 'Rest'))

const summary = computed(() => {
  if (sessions.value.length === 0) return 'Rest week — no sessions scheduled yet.'
  const counts = new Map<string, number>()
  sessions.value.forEach(s => counts.set(s.type, (counts.get(s.type) ?? 0) + 1))
  const parts = [...counts.entries()].map(([type, n]) => `${n} ${workoutTypeLabel[type] ?? type}`)
  return `${sessions.value.length} session${sessions.value.length > 1 ? 's' : ''}: ${parts.join(', ')}`
})

const weekLabel = computed(() => {
  if (weekEntries.value.length === 0) return ''
  const fmt = (d: string) =>
    new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  return `${fmt(weekEntries.value[0].date)} – ${fmt(weekEntries.value[weekEntries.value.length - 1].date)}`
})

const typeIcon  = (t: string) => workoutTypeIcon[t]  ?? 'fa-dumbbell'
const typeLabel = (t: string) => workoutTypeLabel[t] ?? t
const dayLabel  = (date: string) => {
  const d = new Date(date + 'T12:00:00')
  return `${DAY_NAMES[d.getDay()]} ${d.getDate()}`
}
</script>
