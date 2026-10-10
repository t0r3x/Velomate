<template>
  <Teleport to="body">
    <Transition name="confirm-fade">
      <div v-if="open" class="confirm-overlay" @mousedown.self="emit('close')">
        <div class="confirm-dialog plan-changes-dialog glass-panel" role="dialog" aria-modal="true">
          <div class="confirm-header">
            <i class="fa-solid" :class="changes.length ? 'fa-arrow-right-arrow-left' : 'fa-check'"></i>
            <span>{{ changes.length ? 'What changed' : 'Nothing changed' }}</span>
            <button class="panel-close-btn plan-changes-close" aria-label="Close" @click="emit('close')">
              <i class="fa-solid fa-xmark"></i>
            </button>
          </div>

          <!-- Says what this is (the plan re-plans itself), when, and how to read the rows —
               in one sentence, so it stays a glance rather than a manual. -->
          <p class="plan-changes-sub">
            Your plan adapts to every ride, rating and check-in.
            {{ changes.length
              ? `Its last update${when} changed ${changes.length === 1 ? 'this day' : 'these days'}:`
              : `Its last update${when} kept every day as it was.` }}
          </p>

          <ul v-if="changes.length" class="plan-changes-list">
            <li v-for="c in changes" :key="c.date" class="plan-changes-row">
              <span class="plan-changes-day">{{ dayLabel(c.date) }}</span>
              <span class="plan-changes-from">{{ typeLabel(c.from) }}</span>
              <i class="fa-solid fa-arrow-right plan-changes-arrow"></i>
              <span class="plan-changes-to">{{ typeLabel(c.to) }}</span>
            </li>
          </ul>

          <p v-if="note" class="plan-changes-note">{{ note }}</p>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { PlanChange } from '@/types'
import { workoutTypeLabel, DAY_NAMES } from '@/utils'
import { useTimeAgo } from '@/composables/useTimeAgo'

/**
 * Why the plan looks different than it did last time.
 *
 * A plan that rearranges itself in response to a check-in is only trustworthy if the athlete
 * can see what moved and why — otherwise daily adaptation reads as the app being erratic.
 * `changes` is computed server-side and is the authority; `note` is the model's explanation
 * and is shown underneath, so an invented change has nowhere to hide.
 *
 * A dialog opened from the card header, not an inline block: inline it sat between This Week
 * and Next Week and broke up the plan itself. The header button only exists when there is
 * something to show (see AiPlanCard).
 */
const props = defineProps<{
  open: boolean
  changes: PlanChange[]
  note: string | null
  /** When the update that produced these changes ran — shown as "(3h ago)". */
  generatedAt?: string | null
}>()
const emit = defineEmits<{ close: [] }>()

const { timeAgo } = useTimeAgo()
const when = computed(() => (props.generatedAt ? ` (${timeAgo(props.generatedAt)})` : ''))

const typeLabel = (t: string) => workoutTypeLabel[t] ?? t

const dayLabel = (date: string) => {
  const d = new Date(date + 'T12:00:00')
  return `${DAY_NAMES[d.getDay()]} ${d.getDate()} ${d.toLocaleDateString('en-GB', { month: 'short' })}`
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

.plan-changes-dialog {
  width: 100%;
  max-width: 440px;
  max-height: 85vh;
  max-height: 85dvh;
  overflow-y: auto;
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.confirm-header {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  color: var(--text-primary);
}
.confirm-header > i { color: var(--text-muted); }

.plan-changes-close { margin-left: auto; }

.plan-changes-sub {
  margin: 0;
  font-size: 0.82rem;
  line-height: 1.55;
  color: var(--text-secondary);
}

.confirm-fade-enter-active,
.confirm-fade-leave-active {
  transition: opacity 0.18s ease;
}
.confirm-fade-enter-from,
.confirm-fade-leave-to {
  opacity: 0;
}
</style>
