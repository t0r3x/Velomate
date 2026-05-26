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
      <p class="sync-tip">
        <i class="fa-solid fa-calendar-days"></i>
        <span>Your AI training plan is now visible in the <strong>Garmin Connect</strong> calendar — check it in the app or on the web at
        <a href="https://connect.garmin.com" target="_blank" rel="noopener">connect.garmin.com</a>.
        After syncing your device, workouts also appear under <strong>Training Plans</strong> on your Garmin device.</span>
      </p>
      <p class="sync-tip sync-tip--muted">
        <i class="fa-solid fa-share-nodes"></i>
        <span>Want it in Google Calendar or another app? On Garmin Connect web go to
        <strong>Calendar → ⋯ → Publish Calendar</strong> to get a shareable iCal link that you can add to other calendar apps.</span>
      </p>
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
