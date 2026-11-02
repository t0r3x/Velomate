<template>
  <!-- The "?" explanation panel, one design for every card (the Trend card's, made reusable).
       The panel is teleported and fixed: the Rides and Training cards clip their own overflow,
       so a panel inside them would be cut off. Escape, the close button, the "?" or a click
       outside closes it; focus moves in on open and back to the "?" on Escape. -->
  <button
    ref="button"
    type="button"
    class="help-btn"
    :aria-expanded="open"
    :aria-label="label"
    @click.stop="toggle"
  >
    <i class="fa-regular fa-circle-question"></i>
  </button>

  <Teleport to="body">
    <div
      v-if="open"
      ref="panel"
      class="help-panel"
      role="dialog"
      :aria-label="title"
      :style="{ left: `${pos.left}px`, top: `${pos.top}px`, maxHeight: `${pos.maxHeight}px` }"
      @click.stop
    >
      <div class="help-head">
        <span>{{ title }}</span>
        <button type="button" class="help-close" aria-label="Close" @click="close(true)">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
      <slot />
      <p v-if="$slots.foot" class="help-foot"><slot name="foot" /></p>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

const props = withDefaults(defineProps<{ title: string; label?: string }>(), { label: undefined })
const label = props.label ?? props.title

const PANEL_WIDTH = 500
const MARGIN = 16

const open   = ref(false)
const button = ref<HTMLButtonElement | null>(null)
const panel  = ref<HTMLElement | null>(null)
const pos    = ref({ left: 0, top: 0, maxHeight: 400 })

function place() {
  const r = button.value?.getBoundingClientRect()
  if (!r) return
  const width = Math.min(PANEL_WIDTH, window.innerWidth - 2 * MARGIN)
  const left  = Math.max(MARGIN, Math.min(r.left - 8, window.innerWidth - MARGIN - width))
  const top   = r.bottom + 10
  pos.value = { left, top, maxHeight: Math.max(200, window.innerHeight - top - MARGIN) }
}

function toggle() {
  if (open.value) return close(false)
  place()
  open.value = true
  nextTick(() => panel.value?.querySelector<HTMLElement>('button')?.focus())
}
function close(returnFocus: boolean) {
  open.value = false
  if (returnFocus) button.value?.focus()
}

const onDocClick = () => { if (open.value) close(false) }
const onKeydown  = (e: KeyboardEvent) => { if (e.key === 'Escape' && open.value) close(true) }
const onResize   = () => { if (open.value) place() }
onMounted(() => {
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKeydown)
  window.addEventListener('resize', onResize)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onKeydown)
  window.removeEventListener('resize', onResize)
})
</script>
