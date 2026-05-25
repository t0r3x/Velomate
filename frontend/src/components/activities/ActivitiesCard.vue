<template>
  <section class="dashboard-card glass-panel" id="activities-card">
    <div class="card-header">
      <i class="fa-solid fa-bicycle header-icon"></i>
      <h2>Recent Rides</h2>
      <div class="card-header-actions">
        <span class="last-synced-label">{{ lastSyncedLabel }}</span>
        <button
          class="btn btn-secondary btn-sm"
          :disabled="syncing || !authStore.isLoggedIn"
          @click="handleSync"
        >
          <span>{{ syncing ? 'Syncing…' : 'Sync from Garmin' }}</span>
          <i class="fa-solid" :class="syncing ? 'fa-spinner fa-spin' : 'fa-rotate'"></i>
        </button>
      </div>
    </div>
    <div class="card-body scroll-panel">
      <div id="activities-list-container">
        <p v-if="activitiesStore.activities.length === 0" class="helper-text empty-state-text">
          No rides yet. Click "Sync from Garmin" to sync your rides.
        </p>
        <ul v-else class="activities-list">
          <ActivityItem
            v-for="act in activitiesStore.activities"
            :key="act.activityId"
            :activity="act"
            :planEntry="scoreByDate.get(act.startTime?.slice(0, 10) ?? '') ?? null"
          />
        </ul>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useActivitiesStore }    from '@/stores/activities.store'
import { useRecommendationStore } from '@/stores/recommendation.store'
import { useAuthStore }          from '@/stores/auth.store'
import { useToast }              from '@/composables/useToast'
import { useTimeAgo }            from '@/composables/useTimeAgo'
import type { PlanEntry }        from '@/types'
import ActivityItem from './ActivityItem.vue'

const activitiesStore    = useActivitiesStore()
const recommendationStore = useRecommendationStore()
const authStore          = useAuthStore()
const { show }           = useToast()
const { timeAgo }        = useTimeAgo()

const syncing = ref(false)

const lastSyncedLabel = computed(() => {
  const updatedAt = activitiesStore.analysis?.updatedAt
  return updatedAt ? `Last synced ${timeAgo(updatedAt)}` : ''
})

/** Build date → plan entry map for execution score lookup. */
const scoreByDate = computed(() => {
  const map = new Map<string, PlanEntry>()
  for (const e of recommendationStore.recommendation?.weeklyPlan ?? []) {
    if (e.executionScore != null) map.set(e.date, e)
  }
  return map
})

async function handleSync() {
  syncing.value = true
  try {
    const { newCount } = await activitiesStore.syncFromGarmin()
    // Reload plan — backend may have classified workouts as completed
    recommendationStore.fetchCached()
    const total = activitiesStore.activities.length
    show('success', 'Synced from Garmin',
      `${newCount} new ${newCount === 1 ? 'ride' : 'rides'} added — ${total} total stored.`)
  } catch {
    show('error', 'Refresh Failed', 'Could not reach the backend.')
  } finally {
    syncing.value = false
  }
}
</script>
