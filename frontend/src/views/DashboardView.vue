<template>
  <div class="dashboard-shell">
    <MenuBar @open-settings="panelOpen = true" @open-profile="profileModalOpen = true" />

    <div class="app-container dashboard-layout">
      <main class="dashboard-grid">
        <div class="col-assessment">
          <ActivitiesCard />
        </div>
        <div class="col-schedule">
          <FreeTrainingCard v-if="settingsStore.freeTrainingMode" @open-settings="panelOpen = true" />
          <AiPlanCard v-else @open-settings="panelOpen = true" />
        </div>
      </main>
    </div>
  </div>

  <SettingsPanel v-model:open="panelOpen" />

  <!-- HR profile modal overlay -->
  <Teleport to="body">
    <Transition name="confirm-fade">
      <ProfileSetupView
        v-if="profileModalOpen"
        :modalMode="true"
        @confirmed="profileModalOpen = false"
        @cancelled="profileModalOpen = false"
      />
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { useActivitiesStore }    from '@/stores/activities.store'
import { useRecommendationStore } from '@/stores/recommendation.store'
import { useFreeTrainingStore }   from '@/stores/freeTraining.store'
import { useSettingsStore }      from '@/stores/settings.store'
import { useAuthStore }          from '@/stores/auth.store'

import MenuBar        from '@/components/layout/MenuBar.vue'
import SettingsPanel  from '@/components/layout/SettingsPanel.vue'
import ActivitiesCard from '@/components/activities/ActivitiesCard.vue'
import AiPlanCard     from '@/components/recommendation/AiPlanCard.vue'
import FreeTrainingCard from '@/components/recommendation/FreeTrainingCard.vue'
import ProfileSetupView from '@/views/ProfileSetupView.vue'

const panelOpen        = ref(false)
const profileModalOpen = ref(false)
const activitiesStore    = useActivitiesStore()
const recommendationStore = useRecommendationStore()
const freeTrainingStore  = useFreeTrainingStore()
const settingsStore      = useSettingsStore()
const authStore          = useAuthStore()

/** Load whichever training card is currently on screen. */
async function loadActiveMode() {
  if (settingsStore.freeTrainingMode) {
    await freeTrainingStore.fetchCached()
  } else {
    await recommendationStore.fetchCached()
  }
}

// Toggling free training mode in the profile modal swaps the card out underneath us, and
// the store behind the newly shown card has never been fetched — load it on the spot so
// it doesn't sit on its initial 'loading' state until the next reload.
watch(() => settingsStore.freeTrainingMode, () => { loadActiveMode() })

onMounted(async () => {
  activitiesStore.loadFromDb()
  authStore.startPolling()

  // The router guard already initialised the settings store, so freeTrainingMode is
  // known here — only the active mode's store is ever loaded or polled.
  const freeMode = settingsStore.freeTrainingMode

  await loadActiveMode()

  // Watch for output regenerated in the background — not just by our own Garmin sync
  // below, but also independently by the backend's startup/hourly auto-check
  // (runGeminiAutoCheck), which runs the moment the server process starts and has no
  // other way to signal the frontend if it finishes after this initial fetch.
  if (freeMode) {
    freeTrainingStore.pollForUpdate(freeTrainingStore.suggestion?.generatedAt)
  } else {
    recommendationStore.pollForUpdate(recommendationStore.recommendation?.generatedAt)
  }

  // Sync fresh Garmin data as soon as the dashboard opens, instead of only
  // showing whatever was cached at the last sync — mirrors ActivitiesCard's
  // manual "Sync from Garmin" flow so a ride from just before launch is picked
  // up immediately (including an instant execution score, if enabled).
  try {
    await activitiesStore.syncFromGarmin()
    await loadActiveMode()
  } catch {
    // Not authenticated with Garmin, or unreachable — keep showing cached data
  }
})

onUnmounted(() => {
  authStore.stopPolling()
})
</script>
