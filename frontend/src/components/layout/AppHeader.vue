<template>
  <header class="main-header">
    <div class="logo-section">
      <i class="fa-solid logo-icon" :class="logoIcon"></i>
      <h1>UN<span>BOUND</span></h1>
    </div>

    <button class="garmin-status-btn" aria-label="Open Connection & Profile" @click="emit('open-settings')">
      <StatusDot :state="dotState" />
      <span class="status-text">{{ statusText }}</span>
      <span class="garmin-btn-sep"></span>
      <i class="fa-solid fa-heart-pulse garmin-btn-hr-icon"></i>
      <span class="garmin-btn-hr-label">{{ profileStore.hrLabel }}</span>
      <i class="fa-solid fa-chevron-right garmin-btn-arrow"></i>
    </button>
  </header>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useAuthStore }    from '@/stores/auth.store'
import { useProfileStore } from '@/stores/profile.store'
import StatusDot from '@/components/ui/StatusDot.vue'

const emit = defineEmits<{ 'open-settings': [] }>()

const authStore    = useAuthStore()
const profileStore = useProfileStore()

const dotState = computed<'pulsing' | 'connected' | 'disconnected'>(() => {
  if (!authStore.loaded) return 'pulsing'
  return authStore.isLoggedIn ? 'connected' : 'disconnected'
})

const statusText = computed(() => {
  if (!authStore.loaded)    return 'Checking Garmin…'
  return authStore.isLoggedIn ? 'Connected' : 'Not connected'
})

// Shablagoo easter egg — toggled by AppFooter via a shared ref
import { useShablagoo } from '@/composables/useShablagoo'
const { active } = useShablagoo()
const logoIcon = computed(() => active.value ? 'fa-ice-cream' : 'fa-route')
</script>
