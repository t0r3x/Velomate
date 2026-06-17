<template>
  <Teleport to="body">
    <Transition name="confirm-fade">
      <div v-if="visible" class="confirm-overlay" @mousedown.self="_cancel">
        <div class="confirm-dialog glass-panel move-day-dialog" role="dialog" aria-modal="true">
          <div class="confirm-header">
            <i class="fa-solid fa-calendar-days" style="color: rgba(var(--primary-rgb), 1);"></i>
            <span>Move {{ fromTypeLabel }} to…</span>
          </div>

          <div v-if="availableDays.length" class="move-day-list">
            <button
              v-for="day in availableDays"
              :key="day.date"
              class="move-day-row"
              @click="_pick(day.date)"
            >
              <span class="mdr-weekday">{{ day.weekday }}</span>
              <span class="mdr-date">{{ day.dateLabel }}</span>
              <span class="ai-workout-chip mdr-chip" :class="`wt-${day.entry.type.toLowerCase()}`">
                <i class="fa-solid" :class="day.icon"></i>
                {{ day.typeLabel }}
              </span>
            </button>
          </div>

          <p v-else class="move-day-empty">No other days available to move to.</p>

          <div class="confirm-actions">
            <button class="btn btn-secondary btn-sm" @click="_cancel">Cancel</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useMoveDayDialog } from '@/composables/useMoveDayDialog'
import { workoutTypeIcon, workoutTypeLabel, isoDate } from '@/utils'

const { visible, options, _pick, _cancel } = useMoveDayDialog()

const fromTypeLabel = computed(() =>
  options.value ? (workoutTypeLabel[options.value.entry.type] ?? options.value.entry.type) : ''
)

const availableDays = computed(() => {
  if (!options.value) return []
  const { entry, plan } = options.value
  const today = isoDate()
  return plan
    .filter(e => e.date >= today && e.date !== entry.date && e.status === 'planned')
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(e => {
      const d = new Date(e.date + 'T12:00:00')
      return {
        date:      e.date,
        entry:     e,
        weekday:   d.toLocaleDateString('en-GB', { weekday: 'short' }),
        dateLabel: d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
        icon:      workoutTypeIcon[e.type]  ?? 'fa-dumbbell',
        typeLabel: workoutTypeLabel[e.type] ?? e.type,
      }
    })
})
</script>

<style scoped>
.move-day-dialog {
  max-width: 360px;
}

.move-day-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.move-day-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
  text-align: left;
  width: 100%;
  color: var(--text-primary);
  font-family: inherit;
  font-size: 0.875rem;
}

.move-day-row:hover {
  background: rgba(255, 255, 255, 0.09);
  border-color: rgba(var(--primary-rgb), 0.4);
}

.mdr-weekday {
  font-weight: 600;
  color: var(--text-muted);
  width: 32px;
  flex-shrink: 0;
}

.mdr-date {
  color: var(--text-secondary);
  width: 50px;
  flex-shrink: 0;
}

.mdr-chip {
  font-size: 0.72rem;
  padding: 2px 8px;
}

.move-day-empty {
  font-size: 0.875rem;
  color: var(--text-muted);
  margin: 0;
  text-align: center;
  padding: 0.5rem 0;
}

/* Transition (reuse global confirm-fade) */
.confirm-fade-enter-active,
.confirm-fade-leave-active {
  transition: opacity 0.18s ease;
}
.confirm-fade-enter-from,
.confirm-fade-leave-to {
  opacity: 0;
}
.confirm-fade-enter-active .confirm-dialog,
.confirm-fade-leave-active .confirm-dialog {
  transition: transform 0.18s ease, opacity 0.18s ease;
}
.confirm-fade-enter-from .confirm-dialog,
.confirm-fade-leave-to .confirm-dialog {
  transform: scale(0.95);
  opacity: 0;
}
</style>
