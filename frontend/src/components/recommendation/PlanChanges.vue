<template>
  <!-- Nothing to say on a first plan: there is no previous version to differ from. -->
  <div v-if="changes.length || note" class="plan-changes">
    <div class="plan-changes-head">
      <i class="fa-solid" :class="changes.length ? 'fa-arrow-right-arrow-left' : 'fa-check'"></i>
      <span>{{ changes.length ? `What changed · ${changes.length} ${changes.length === 1 ? 'day' : 'days'}` : 'Nothing changed' }}</span>
    </div>

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
</template>

<script setup lang="ts">
import type { PlanChange } from '@/types'
import { workoutTypeLabel, DAY_NAMES } from '@/utils'

/**
 * Why the plan looks different than it did last time.
 *
 * A plan that rearranges itself in response to a check-in is only trustworthy if the athlete
 * can see what moved and why — otherwise daily adaptation reads as the app being erratic.
 * `changes` is computed server-side and is the authority; `note` is the model's explanation
 * and is shown underneath, so an invented change has nowhere to hide.
 */
const props = defineProps<{
  changes: PlanChange[]
  note: string | null
}>()

const typeLabel = (t: string) => workoutTypeLabel[t] ?? t

const dayLabel = (date: string) => {
  const d = new Date(date + 'T12:00:00')
  return `${DAY_NAMES[d.getDay()]} ${d.getDate()} ${d.toLocaleDateString('en-GB', { month: 'short' })}`
}
</script>
