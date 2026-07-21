<template>
  <!-- In Electron this teleports into the title bar so everything lives in one
       native-feeling row (icon, menu items, window controls). Outside Electron
       there's no title bar to teleport into, so it just renders in place as
       its own row (disabled Teleport = render where declared). -->
  <Teleport to="#titlebar-menu-slot" :disabled="!isElectronMode">
    <nav class="menu-bar" :class="{ 'menu-bar-standalone': !isElectronMode }">
      <button class="menu-item" title="Connection settings" @click="emit('open-settings')">
        <StatusDot :state="dotState" />
        <span>{{ statusText }}</span>
      </button>

      <button class="menu-item" title="Training profile" @click="emit('open-profile')">
        <i class="fa-solid fa-heart-pulse menu-item-hr-icon"></i>
        <span>{{ profileStore.hrLabel }}</span>
      </button>

      <button class="menu-item menu-item-icon" title="About Velomate" @click="aboutOpen = true">
        <i class="fa-solid fa-circle-info"></i>
      </button>
    </nav>
  </Teleport>

  <AboutDialog :open="aboutOpen" @close="aboutOpen = false" />
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useAuthStore }    from '@/stores/auth.store'
import { useProfileStore } from '@/stores/profile.store'
import StatusDot           from '@/components/ui/StatusDot.vue'
import AboutDialog         from '@/components/layout/AboutDialog.vue'
import { isElectron }      from '@/utils/electron'

const isElectronMode = isElectron()

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
