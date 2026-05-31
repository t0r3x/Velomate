<template>
  <div class="app-container">
    <AppHeader @open-settings="panelOpen = true" />

    <main class="dashboard-grid">
      <div class="col-assessment" ref="assessmentCol">
        <ActivitiesCard />
      </div>
      <div class="col-schedule" ref="scheduleCol">
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
import { ref, nextTick, onMounted, onUnmounted } from 'vue'
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
const assessmentCol    = ref<HTMLElement | null>(null)
const scheduleCol      = ref<HTMLElement | null>(null)

const activitiesStore    = useActivitiesStore()
const recommendationStore = useRecommendationStore()
const authStore          = useAuthStore()

let heightObserver: ResizeObserver | null = null

function syncColumnHeights() {
  const planCard        = scheduleCol.value?.querySelector<HTMLElement>('.dashboard-card')
  const activitiesCard  = assessmentCol.value?.querySelector<HTMLElement>('.dashboard-card')
  if (!planCard || !activitiesCard) return
  const h = planCard.offsetHeight + 'px'
  activitiesCard.style.minHeight = h
  activitiesCard.style.maxHeight = h
}

onMounted(async () => {
  // Fast DB render — no Garmin call
  activitiesStore.loadFromDb()
  // Load cached AI plan
  recommendationStore.fetchCached()
  // Start 30s Garmin session polling
  authStore.startPolling()

  await nextTick()
  const planCard = scheduleCol.value?.querySelector('.dashboard-card')
  if (planCard) {
    heightObserver = new ResizeObserver(syncColumnHeights)
    heightObserver.observe(planCard)
    syncColumnHeights()
  }
})

onUnmounted(() => {
  authStore.stopPolling()
  heightObserver?.disconnect()
})
</script>
