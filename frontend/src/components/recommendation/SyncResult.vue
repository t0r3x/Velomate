<template>
  <div v-if="result" id="sync-result" class="notification-card">
    <div class="notification-header">
      <i class="fa-solid fa-circle-check"></i>
      <span>Sync Complete</span>
    </div>
    <div class="notification-body">
      <p>{{ syncMsg }}</p>
      <ul class="workout-bullets">
        <li v-for="(w, i) in result.workouts" :key="i">
          Workout <strong>{{ w.name }}</strong>
          <span :style="{ color: statusColor(w) }">{{ statusText(w) }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { SyncResult, SyncedWorkout } from '@/types'

const props = defineProps<{ result: SyncResult | null }>()

const syncMsg = computed(() => {
  const count = props.result?.workouts.length ?? 0
  return `Uploaded and scheduled ${count} workout${count !== 1 ? 's' : ''} on Garmin. Sync your device to apply!`
})

function statusText(w: SyncedWorkout): string {
  if (w.scheduleError) return '(Upload only — schedule manually)'
  if (w.scheduledDate) {
    const d = new Date(w.scheduledDate + 'T12:00:00')
    const dFmt = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
    return `(Scheduled for ${dFmt})`
  }
  return '(Available on Device)'
}

function statusColor(w: SyncedWorkout): string {
  if (w.scheduleError) return 'var(--z3-color, #e6d46e)'
  if (w.scheduledDate) return 'var(--z4-color)'
  return 'var(--text-muted)'
}
</script>
