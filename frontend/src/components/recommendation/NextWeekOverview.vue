<template>
  <div class="ai-next-week">
    <div class="ai-next-week-header">
      <i class="fa-solid fa-calendar"></i>
      <span>Next Week</span>
    </div>
    <p class="ai-next-week-summary">{{ overview.summary }}</p>
    <div class="ai-next-week-chips">
      <span
        v-for="(s, i) in overview.sessions"
        :key="i"
        class="ai-workout-chip ai-next-week-chip"
        :class="`wt-${s.type.toLowerCase()}`"
      >
        <i class="fa-solid" :class="typeIcon(s.type)"></i>
        <span class="nw-type">{{ typeLabel(s.type) }}</span>
        <span class="nw-day">{{ s.estimatedDay }}</span>
      </span>
    </div>
    <p class="ai-next-week-emphasis">{{ overview.emphasis }}</p>
  </div>
</template>

<script setup lang="ts">
import type { NextWeekOverview } from '@/types'
import { workoutTypeIcon, workoutTypeLabel } from '@/utils'

defineProps<{ overview: NextWeekOverview }>()

const typeIcon  = (t: string) => workoutTypeIcon[t]  ?? 'fa-dumbbell'
const typeLabel = (t: string) => workoutTypeLabel[t] ?? t
</script>
