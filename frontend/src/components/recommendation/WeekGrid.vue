<template>
  <div>
    <div class="week-preview-header">
      <i class="fa-solid fa-calendar-week"></i>
      <span>This Week</span>
      <span class="week-label">{{ weekLabel }}</span>
    </div>
    <div class="week-grid" id="ai-week-grid">
      <WeekDayCell
        v-for="entry in displayPlan"
        :key="entry.date"
        :entry="entry"
        :isToday="entry.date === todayStr"
        @reschedule="emit('reschedule', $event)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { PlanEntry } from '@/types'
import { isoDate } from '@/utils'
import WeekDayCell from './WeekDayCell.vue'

const props = defineProps<{ plan: PlanEntry[] }>()
const emit  = defineEmits<{ reschedule: [date: string] }>()

const todayStr = isoDate()

const displayPlan = computed(() =>
  props.plan.filter(e => e.date >= todayStr).slice(0, 7)
)

const weekLabel = computed(() => {
  if (displayPlan.value.length === 0) return ''
  const fmt = (d: string) =>
    new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  const first = displayPlan.value[0].date
  const last  = displayPlan.value[displayPlan.value.length - 1].date
  return `${fmt(first)} – ${fmt(last)}`
})
</script>
