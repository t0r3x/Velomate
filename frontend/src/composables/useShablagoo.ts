import { ref, watch } from 'vue'

// Shared singleton for the Mintberry Crunch easter egg
const active = ref(false)

// Drives a body class directly so the effect survives the AboutDialog
// (and its #shablagoo-toggle checkbox) unmounting when the dialog closes.
watch(active, (val) => {
  document.body.classList.toggle('shablagoo-active', val)
}, { immediate: true })

export function useShablagoo() {
  function toggle(val: boolean) {
    active.value = val
  }
  return { active, toggle }
}
