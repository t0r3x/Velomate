<template>
  <header class="main-header">
    <div class="logo-section">
      <img v-if="!active" class="logo-header" :src="veloImg" alt="" />
      <img v-else class="logo-header" :src="mbcImg" alt="" />
      <div class="logo-text">
        <h1>Velo<span>mate</span></h1>
        <p class="logo-tagline">The adaptive AI cycling coach for Garmin Connect</p>
      </div>
    </div>

    <div class="header-menu-wrapper" ref="wrapperRef">
      <button class="garmin-status-btn" @click="toggleDropdown">
        <StatusDot :state="dotState" />
        <span class="status-text">{{ statusText }}</span>
        <span class="garmin-btn-sep"></span>
        <i class="fa-solid fa-heart-pulse garmin-btn-hr-icon"></i>
        <span class="garmin-btn-hr-label">{{ profileStore.hrLabel }}</span>
        <i class="fa-solid fa-chevron-down garmin-btn-arrow" :class="{ 'rotate-180': dropdownOpen }"></i>
      </button>

      <div v-if="dropdownOpen" class="header-dropdown">
        <button class="header-dropdown-item" @click="select('connections')">
          <i class="fa-solid fa-plug"></i>
          <span>Connections</span>
        </button>
        <button class="header-dropdown-item" @click="select('profile')">
          <i class="fa-solid fa-user-gear"></i>
          <span>Training Profile</span>
        </button>
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useAuthStore }    from '@/stores/auth.store'
import { useProfileStore } from '@/stores/profile.store'
import StatusDot           from '@/components/ui/StatusDot.vue'
import { useShablagoo }    from '@/composables/useShablagoo'
import veloImg            from '@/assets/velomate.png'
import mbcImg            from '@/assets/mbc.png'

const emit = defineEmits<{ 'open-settings': []; 'open-profile': [] }>()

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

// Dropdown
const dropdownOpen = ref(false)
const wrapperRef   = ref<HTMLElement | null>(null)

function toggleDropdown() {
  dropdownOpen.value = !dropdownOpen.value
}

function select(target: 'connections' | 'profile') {
  dropdownOpen.value = false
  if (target === 'connections') emit('open-settings')
  else emit('open-profile')
}

function onClickOutside(e: MouseEvent) {
  if (wrapperRef.value && !wrapperRef.value.contains(e.target as Node)) {
    dropdownOpen.value = false
  }
}

onMounted(() => document.addEventListener('mousedown', onClickOutside))
onUnmounted(() => document.removeEventListener('mousedown', onClickOutside))

// Shablagoo easter egg
const { active } = useShablagoo()
</script>
