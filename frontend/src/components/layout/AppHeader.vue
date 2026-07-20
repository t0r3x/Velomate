<template>
  <header class="main-header">
    <button class="header-chip" title="Connection settings" @click="emit('open-settings')">
      <StatusDot :state="dotState" />
      <span>{{ statusText }}</span>
    </button>

    <button class="header-chip" title="Training profile" @click="emit('open-profile')">
      <i class="fa-solid fa-heart-pulse header-chip-hr-icon"></i>
      <span>{{ profileStore.hrLabel }}</span>
    </button>

    <button class="header-chip header-chip-icon" title="About Velomate" @click="aboutOpen = true">
      <i class="fa-solid fa-circle-info"></i>
    </button>
  </header>

  <AboutDialog :open="aboutOpen" @close="aboutOpen = false" />
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useAuthStore }    from '@/stores/auth.store'
import { useProfileStore } from '@/stores/profile.store'
import StatusDot           from '@/components/ui/StatusDot.vue'
import AboutDialog         from '@/components/layout/AboutDialog.vue'

const emit = defineEmits<{ 'open-settings': []; 'open-profile': [] }>()

const aboutOpen = ref(false)

const authStore    = useAuthStore()
const profileStore = useProfileStore()

const dotState = computed<'pulsing' | 'connected' | 'disconnected'>(() => {
  if (!authStore.loaded) return 'pulsing'
  return authStore.isLoggedIn ? 'connected' : 'disconnected'
})

const statusText = computed(() => {
  if (!authStore.loaded) return 'Checking Garmin…'
  return authStore.isLoggedIn ? 'Connected' : 'Not connected'
})
</script>
