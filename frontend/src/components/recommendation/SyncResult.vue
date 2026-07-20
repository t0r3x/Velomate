<template>
  <Teleport to="body">
    <Transition name="confirm-fade">
      <div v-if="result" class="confirm-overlay" @mousedown.self="emit('close')">
        <div class="confirm-dialog sync-result-dialog glass-panel" role="dialog" aria-modal="true">
          <div class="confirm-header">
            <i class="fa-solid fa-circle-check" style="color: var(--z2-color);"></i>
            <span>Sync Complete</span>
            <button class="panel-close-btn sync-result-close" @click="emit('close')" aria-label="Close">
              <i class="fa-solid fa-xmark"></i>
            </button>
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
          <div class="confirm-actions">
            <button class="btn btn-primary btn-sm" @click="emit('close')">Got it</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { SyncResult, SyncedWorkout } from '@/types'

const props = defineProps<{ result: SyncResult | null }>()
const emit = defineEmits<{ close: [] }>()

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

<style scoped>
.confirm-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(4px);
  padding: 1rem;
}

.sync-result-dialog {
  width: 100%;
  max-width: 480px;
  max-height: 85vh;
  overflow-y: auto;
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.confirm-header {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-primary);
}

.sync-result-close {
  margin-left: auto;
}

.confirm-actions {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
}

/* Transition (reuses the same confirm-fade convention as the other dialogs) */
.confirm-fade-enter-active,
.confirm-fade-leave-active {
  transition: opacity 0.18s ease;
}
.confirm-fade-enter-from,
.confirm-fade-leave-to {
  opacity: 0;
}
.confirm-fade-enter-active .sync-result-dialog,
.confirm-fade-leave-active .sync-result-dialog {
  transition: transform 0.18s ease, opacity 0.18s ease;
}
.confirm-fade-enter-from .sync-result-dialog,
.confirm-fade-leave-to .sync-result-dialog {
  transform: scale(0.95);
  opacity: 0;
}
</style>
