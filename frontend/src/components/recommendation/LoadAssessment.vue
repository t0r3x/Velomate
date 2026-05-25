<template>
  <div class="ai-load-assessment">
    <div class="ai-load-header">
      <span class="ai-load-fatigue-badge" :class="`fatigue-${fatigueLower}`">
        {{ fatigueLabel }}
      </span>
      <span v-if="assessment.weeklyLoadTrend" class="ai-load-trend">
        Load: {{ assessment.weeklyLoadTrend }}
      </span>
    </div>
    <p v-if="assessment.insight" class="ai-load-insight">{{ assessment.insight }}</p>
    <p v-if="generatedAt" class="ai-generated-at">Updated {{ timeAgo(generatedAt) }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { LoadAssessment } from '@/types'
import { useTimeAgo } from '@/composables/useTimeAgo'

const props = defineProps<{
  assessment: LoadAssessment
  generatedAt?: string
}>()

const { timeAgo } = useTimeAgo()

const fatigueLower = computed(() => (props.assessment.fatigue || 'low').toLowerCase())
const fatigueLabel = computed(() => {
  const f = props.assessment.fatigue
  return f ? f.charAt(0).toUpperCase() + f.slice(1) + ' fatigue' : ''
})
</script>
