<template>
  <div class="zones-stacked-bar" id="ps-zones-bar">
    <div
      v-for="seg in segments"
      :key="seg.key"
      class="zone-bar-segment"
      :class="seg.key"
      :style="{ width: `${seg.width}%` }"
      :title="`${seg.key.toUpperCase()}: ${seg.min}–${seg.max} bpm`"
    >
      <span class="zbs-name">{{ seg.key.toUpperCase() }}</span>
      <span class="zbs-range">{{ seg.min }}–{{ seg.max }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { toRef } from 'vue'
import { useZones } from '@/composables/useZones'

const props = defineProps<{ maxHr: number; lthr: number }>()
const { segments } = useZones(toRef(props, 'maxHr'), toRef(props, 'lthr'))
</script>
