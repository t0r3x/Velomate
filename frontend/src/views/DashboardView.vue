<template>
  <div class="app-container">
    <AppHeader @open-settings="panelOpen = true" />

    <main class="dashboard-grid">
      <div class="col-assessment">
        <ActivitiesCard />
      </div>
      <div class="col-schedule">
        <AiPlanCard @open-settings="panelOpen = true" />
      </div>
    </main>

    <AppFooter />
  </div>

  <SettingsPanel
    v-model:open="panelOpen"
    @edit-profile="profileModalOpen = true"
  />

  <!-- HR profile modal overlay -->
  <Teleport to="body">
    <ProfileSetupView
      v-if="profileModalOpen"
      :modalMode="true"
      @confirmed="profileModalOpen = false"
      @cancelled="profileModalOpen = false"
    />
  </Teleport>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useActivitiesStore }    from '@/stores/activities.store'
import { useRecommendationStore } from '@/stores/recommendation.store'
import { useAuthStore }          from '@/stores/auth.store'

import AppHeader      from '@/components/layout/AppHeader.vue'
import AppFooter      from '@/components/layout/AppFooter.vue'
import SettingsPanel  from '@/components/layout/SettingsPanel.vue'
import ActivitiesCard from '@/components/activities/ActivitiesCard.vue'
import AiPlanCard     from '@/components/recommendation/AiPlanCard.vue'
import ProfileSetupView from '@/views/ProfileSetupView.vue'

const panelOpen        = ref(false)
const profileModalOpen = ref(false)

const activitiesStore    = useActivitiesStore()
const recommendationStore = useRecommendationStore()
const authStore          = useAuthStore()

onMounted(async () => {
  // Fast DB render — no Garmin call
  activitiesStore.loadFromDb()
  // Load cached AI plan
  recommendationStore.fetchCached()
  // Start 30s Garmin session polling
  authStore.startPolling()
})

onUnmounted(() => {
  authStore.stopPolling()
})
</script>
