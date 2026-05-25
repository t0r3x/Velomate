import { ref } from 'vue'

// Shared singleton for the Mintberry Crunch easter egg
const active = ref(false)

export function useShablagoo() {
  function toggle(val: boolean) {
    active.value = val
  }
  return { active, toggle }
}
