<template>
  <div class="wdp-panel">
    <!-- Header -->
    <div class="wdp-header">
      <div class="wdp-title-block">
        <span class="wdp-day-label">{{ dayLabel }} {{ dayOfMonth }}</span>
        <span class="ai-workout-chip" :class="`wt-${entry.type.toLowerCase()}`">
          <i class="fa-solid" :class="typeIcon"></i>
          {{ typeLabel }}
        </span>
        <span v-if="durationText" class="wdp-duration">{{ durationText }}</span>
        <span v-if="priorityLabel && props.entry.status === 'planned'" class="ai-priority-badge" :class="`priority-${props.priority!.toLowerCase()}`">
          {{ priorityLabel }}
        </span>
      </div>
    </div>

    <!-- Zone bar -->
    <div v-if="steps.length" class="wdp-zone-bar">
      <div
        v-for="(step, i) in steps"
        :key="i"
        class="wdp-bar-seg"
        :class="step.zone"
        :style="{ flex: step.durationSec }"
        :title="`${step.label} – ${fmtDur(step.durationSec)}`"
      />
    </div>

    <!-- Step list -->
    <div v-if="steps.length" class="wdp-steps">
      <div v-for="(step, i) in steps" :key="i" class="wdp-step-row">
        <span class="wdp-step-dot" :class="step.zone" />
        <span class="wdp-step-zone-pill" :class="step.zone">{{ step.zone.toUpperCase() }}</span>
        <span class="wdp-step-label">{{ step.label }}</span>
        <span class="wdp-step-dur">{{ fmtDur(step.durationSec) }}</span>
      </div>
    </div>

    <!-- Reason -->
    <p v-if="isPastPlaceholder" class="wdp-reason wdp-placeholder-note">
      No plan data exists for this day — it's before the AI plan's history began, so there's nothing to refresh.
    </p>
    <p v-else-if="isPlaceholder" class="wdp-reason wdp-placeholder-note">
      This day isn't in the AI's current plan yet — refresh the plan to extend its coverage.
    </p>
    <p v-else-if="entry.reason" class="wdp-reason">{{ entry.reason }}</p>

    <!-- Action buttons -->
    <div v-if="canSkip || canMove" class="wdp-actions">
      <button v-if="canSkip" class="btn btn-secondary btn-sm" @click="emit('skip', entry.date)">
        <i class="fa-solid fa-forward-step"></i>
        <span>Skip</span>
      </button>
      <button v-if="canMove" class="btn btn-secondary btn-sm" @click="emit('reschedule', entry.date)">
        <i class="fa-solid fa-calendar-day"></i>
        <span>Move</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { PlanEntry } from '@/types'
import { workoutTypeIcon as iconMap, workoutTypeLabel as labelMap, DAY_NAMES, isoDate } from '@/utils'

const props = defineProps<{ entry: PlanEntry; priority?: string }>()
const emit  = defineEmits<{
  skip: [date: string]
  reschedule: [date: string]
}>()

const PRIORITY_LABELS: Record<string, string> = {
  high: 'Essential', medium: 'Recommended', low: 'Optional'
}
const priorityLabel = computed(() =>
  props.priority ? (PRIORITY_LABELS[props.priority.toLowerCase()] ?? props.priority) : ''
)

const d            = computed(() => new Date(props.entry.date + 'T12:00:00'))
const dayLabel     = computed(() => DAY_NAMES[d.value.getDay()])
const dayOfMonth   = computed(() => d.value.getDate())
const isPlaceholder     = computed(() => !!props.entry.isPlaceholder)
const isPastPlaceholder = computed(() => !!props.entry.isPastPlaceholder)
const typeIcon     = computed(() => isPastPlaceholder.value ? 'fa-minus' : isPlaceholder.value ? 'fa-hourglass-half' : (iconMap[props.entry.type]  ?? 'fa-dumbbell'))
const typeLabel    = computed(() => isPastPlaceholder.value ? 'No data' : isPlaceholder.value ? 'Not planned' : (labelMap[props.entry.type] ?? props.entry.type))
const steps        = computed(() => props.entry.structure?.steps ?? [])
const durationText = computed(() =>
  props.entry.structure?.totalMinutes ? `${props.entry.structure.totalMinutes} min` : ''
)

const canSkip = computed(() =>
  !isPlaceholder.value && props.entry.status === 'planned'
)
const canMove = computed(() =>
  !isPlaceholder.value && props.entry.date >= isoDate() && props.entry.status === 'planned'
)

function fmtDur(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return s ? `${m}:${String(s).padStart(2, '0')}` : `${m} min`
}
</script>

<style scoped>
.wdp-panel {
  background: rgba(10, 13, 26, 0.92);
  border-top: 1px solid rgba(255, 255, 255, 0.07);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.wdp-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.wdp-title-block {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  flex-wrap: wrap;
}

.wdp-day-label {
  font-size: 0.78rem;
  color: var(--text-muted);
  font-weight: 600;
}

.wdp-duration {
  font-size: 0.75rem;
  color: var(--text-muted);
}

/* Zone bar */
.wdp-zone-bar {
  display: flex;
  height: 8px;
  border-radius: 4px;
  overflow: hidden;
  gap: 2px;
}

.wdp-bar-seg {
  height: 100%;
  border-radius: 2px;
  min-width: 4px;
}

.wdp-bar-seg.z1 { background: var(--z1-color); opacity: 0.6; }
.wdp-bar-seg.z2 { background: var(--z2-color); }
.wdp-bar-seg.z3 { background: var(--z3-color); }
.wdp-bar-seg.z4 { background: var(--z4-color); }
.wdp-bar-seg.z5 { background: var(--z5-color); }

/* Step list */
.wdp-steps {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.wdp-step-row {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 0.78rem;
}

.wdp-step-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.wdp-step-dot.z1 { background: var(--z1-color); }
.wdp-step-dot.z2 { background: var(--z2-color); }
.wdp-step-dot.z3 { background: var(--z3-color); }
.wdp-step-dot.z4 { background: var(--z4-color); }
.wdp-step-dot.z5 { background: var(--z5-color); }

.wdp-step-zone-pill {
  font-size: 0.65rem;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 4px;
  letter-spacing: 0.03em;
  white-space: nowrap;
}
.wdp-step-zone-pill.z1 { background: rgba(100, 116, 139, 0.2); color: var(--z1-color); }
.wdp-step-zone-pill.z2 { background: rgba(16, 185, 129, 0.15);  color: var(--z2-color); }
.wdp-step-zone-pill.z3 { background: rgba(6, 182, 212, 0.15);   color: var(--z3-color); }
.wdp-step-zone-pill.z4 { background: rgba(245, 158, 11, 0.15);  color: var(--z4-color); }
.wdp-step-zone-pill.z5 { background: rgba(239, 68, 68, 0.15);   color: var(--z5-color); }

.wdp-step-label {
  flex: 1;
  color: var(--text-secondary);
}

.wdp-step-dur {
  color: var(--text-muted);
  font-size: 0.73rem;
  white-space: nowrap;
}

/* Reason */
.wdp-reason {
  font-size: 0.80rem;
  color: var(--text-secondary);
  line-height: 1.5;
  border-top: 1px solid rgba(255, 255, 255, 0.05);
  padding-top: 8px;
  margin: 0;
}

.wdp-placeholder-note {
  color: var(--text-muted);
  font-style: italic;
}

/* Action buttons */
.wdp-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
