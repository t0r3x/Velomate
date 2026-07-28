<template>
  <div class="zones-stacked-bar" ref="barEl">
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

    <div
      v-for="(pos, i) in boundaries"
      :key="`handle-${i}`"
      class="zone-drag-handle"
      :class="{ dragging: draggingIndex === i }"
      :style="{ left: `${pos}%` }"
      title="Drag to adjust this zone boundary"
      @pointerdown="startDrag(i, $event)"
    >
      <i class="fa-solid fa-grip-lines-vertical"></i>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onBeforeUnmount } from 'vue'
import type { HrZones } from '@/types'
import { zonesToSegments } from '@/composables/useZones'

const props = defineProps<{ zones: HrZones; maxHr: number }>()
const emit  = defineEmits<{ 'update:zones': [HrZones] }>()

const segments = computed(() => zonesToSegments(props.zones, props.maxHr))

// Cumulative width% after each of the first 4 zones — where the 4 draggable
// boundaries (z1|z2, z2|z3, z3|z4, z4|z5) sit along the bar.
const boundaries = computed(() => {
  const result: number[] = []
  let acc = 0
  for (let i = 0; i < segments.value.length - 1; i++) {
    acc += segments.value[i].width
    result.push(acc)
  }
  return result
})

const barEl = ref<HTMLElement | null>(null)
const draggingIndex = ref<number | null>(null)

const ZONE_KEYS: (keyof HrZones)[] = ['z1', 'z2', 'z3', 'z4', 'z5']

function startDrag(i: number, e: PointerEvent) {
  draggingIndex.value = i
  ;(e.target as Element).setPointerCapture(e.pointerId)
  window.addEventListener('pointermove', onDrag)
  window.addEventListener('pointerup', stopDrag)
}

function onDrag(e: PointerEvent) {
  if (draggingIndex.value === null || !barEl.value) return
  const i = draggingIndex.value
  const rect = barEl.value.getBoundingClientRect()
  const relX = Math.min(Math.max(e.clientX - rect.left, 0), rect.width)
  let bpm = Math.round((relX / rect.width) * props.maxHr)

  const lowerKey = ZONE_KEYS[i]
  const upperKey = ZONE_KEYS[i + 1]
  const lowerMin = props.zones[lowerKey].min
  const upperMax = props.zones[upperKey].max

  // Keep at least 1 bpm of width on each side of the boundary being dragged.
  bpm = Math.min(Math.max(bpm, lowerMin + 1), upperMax - 1)

  emit('update:zones', {
    ...props.zones,
    [lowerKey]: { ...props.zones[lowerKey], max: bpm },
    [upperKey]: { ...props.zones[upperKey], min: bpm + 1 }
  })
}

function stopDrag() {
  draggingIndex.value = null
  window.removeEventListener('pointermove', onDrag)
  window.removeEventListener('pointerup', stopDrag)
}

onBeforeUnmount(stopDrag)
</script>
