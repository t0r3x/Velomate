<template>
  <div v-if="entries.length" class="fh-block">
    <div class="week-preview-header">
      <i class="fa-solid fa-clock-rotate-left"></i>
      <span>Recent Suggestions</span>
      <span class="week-label">{{ entries.length }} shown</span>
    </div>

    <ul class="fh-list">
      <li v-for="item in entries" :key="item.id" class="fh-row">
        <span class="ai-workout-chip fh-chip" :class="`wt-${item.workoutType.toLowerCase()}`">
          <i class="fa-solid" :class="workoutTypeIcon[item.workoutType] ?? 'fa-dumbbell'"></i>
          {{ workoutTypeLabel[item.workoutType] ?? item.workoutType }}
        </span>

        <span class="fh-meta">{{ outcomeText(item) }}</span>

        <span
          v-if="item.executionScore != null"
          class="act-score-badge"
          :class="scoreClass(item.executionScore)"
          :title="item.executionNote || ''"
        >
          {{ item.executionScore }}
        </span>
        <span v-else-if="item.status === 'completed'" class="act-score-badge fh-badge-pending">
          Scoring…
        </span>
      </li>
    </ul>

    <p v-if="latestNote" class="fh-note">“{{ latestNote }}”</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { FreeSuggestion } from '@/types'
import { workoutTypeIcon, workoutTypeLabel } from '@/utils'

const props = defineProps<{ history: FreeSuggestion[]; limit?: number }>()

const entries = computed(() => props.history.slice(0, props.limit ?? 6))

/** The most recent scoring rationale — the one piece of history worth reading in full. */
const latestNote = computed(() =>
  entries.value.find(e => e.executionScore != null && e.executionNote)?.executionNote ?? ''
)

const fmtDate = (iso: string): string =>
  new Date(iso.slice(0, 10) + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })

/**
 * One line describing what happened to a past suggestion. 'superseded' means it was
 * replaced by a fresher read of the same data, not something the athlete rejected —
 * worth distinguishing so the list doesn't read like a wall of missed workouts.
 */
function outcomeText(item: FreeSuggestion): string {
  if (item.status === 'completed') {
    return `Ridden ${fmtDate(item.completedDate ?? item.generatedAt)}`
  }
  if (item.status === 'dismissed') {
    return item.syncedForDate
      ? `Synced ${fmtDate(item.syncedForDate)} — not ridden`
      : `Suggested ${fmtDate(item.generatedAt)} — skipped`
  }
  return `Suggested ${fmtDate(item.generatedAt)} — replaced`
}

function scoreClass(score: number): string {
  return score >= 80 ? 'score-great' : score >= 60 ? 'score-ok' : 'score-poor'
}
</script>

<style scoped>
.fh-block {
  margin-top: 1rem;
}

.fh-list {
  list-style: none;
  margin: 0.5rem 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.fh-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.78rem;
}

.fh-chip {
  flex-shrink: 0;
}

.fh-meta {
  flex: 1;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fh-badge-pending {
  background: rgba(120, 113, 108, 0.12);
  color: var(--text-muted);
  border-color: rgba(120, 113, 108, 0.22);
}

.fh-note {
  margin: 0.6rem 0 0;
  font-size: 0.78rem;
  font-style: italic;
  color: var(--text-secondary);
  line-height: 1.5;
}
</style>
