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
          <span>{{ syncing ? 'Syncing…' : 'Sync' }}</span>
          <i v-if="syncing" class="fa-solid fa-spinner fa-spin"></i>
        </button>
      </div>
    </div>
    <div class="card-body scroll-panel">
      <div id="activities-list-container">
        <p v-if="activitiesStore.activities.length === 0" class="helper-text empty-state-text">
          No rides yet. Click "Sync" to sync your rides from Garmin.
        </p>
        <ul v-else class="activities-list">
          <ActivityItem
            v-for="act in activitiesStore.activities"
            :key="act.activityId"
            :activity="act"
            :planEntry="scoreByDate.get(act.startTime?.slice(0, 10) ?? '') ?? null"
            @rated="handleRated"
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
import { useFreeTrainingStore }   from '@/stores/freeTraining.store'
import { useSettingsStore }      from '@/stores/settings.store'
import { useAuthStore }          from '@/stores/auth.store'
import { useToast }              from '@/composables/useToast'
import { useTimeAgo }            from '@/composables/useTimeAgo'
import type { PlanEntry }        from '@/types'
import ActivityItem from './ActivityItem.vue'

const activitiesStore    = useActivitiesStore()
const recommendationStore = useRecommendationStore()
const freeTrainingStore  = useFreeTrainingStore()
const settingsStore      = useSettingsStore()
const authStore          = useAuthStore()
const { show }           = useToast()
const { timeAgo }        = useTimeAgo()

const syncing = ref(false)

/**
 * A rating is the athlete telling the app how the ride actually felt, so it feeds the same
 * re-evaluation a newly completed ride does. Reuses the sync path's polling so the updated
 * plan arrives without a reload.
 */
function handleRated(regenerating: boolean) {
  if (!regenerating) return
  if (settingsStore.freeTrainingMode) {
    freeTrainingStore.pollForUpdate(freeTrainingStore.suggestion?.generatedAt, 20, true)
  } else {
    recommendationStore.pollForUpdate(recommendationStore.recommendation?.generatedAt, 20, true)
  }
}

const lastSyncedLabel = computed(() => {
  const updatedAt = activitiesStore.analysis?.updatedAt
  return updatedAt ? `Last synced ${timeAgo(updatedAt)}` : ''
})

/**
 * Build date → scored entry map for the execution score badge on each activity.
 * Both modes produce the same 0-100 score, they just store it differently: the plan keeps
 * it on the dated plan entry, free mode on the suggestion the ride was matched to (whose
 * completedDate is the ride's date). Normalised to PlanEntry so ActivityItem is unchanged.
 */
const scoreByDate = computed(() => {
  const map = new Map<string, PlanEntry>()
  if (settingsStore.freeTrainingMode) {
    for (const s of freeTrainingStore.history) {
      if (s.executionScore == null || !s.completedDate) continue
      map.set(s.completedDate, {
        date:           s.completedDate,
        type:           s.workoutType,
        reason:         s.reason,
        status:         'completed',
        executionScore: s.executionScore,
        executionNote:  s.executionNote,
      })
    }
  } else {
    for (const e of recommendationStore.recommendation?.weeklyPlan ?? []) {
      if (e.executionScore != null) map.set(e.date, e)
    }
  }
  return map
})

async function handleSync() {
  syncing.value = true
  try {
    const { newCount, planRegenTriggered } = await activitiesStore.syncFromGarmin()
    // Reload the active mode's output to reflect newly matched rides (e.g. Done badge)
    if (settingsStore.freeTrainingMode) {
      await freeTrainingStore.fetchCached()
      if (planRegenTriggered) {
        // Regen was triggered non-blocking — poll until scores arrive, showing the inline indicator
        freeTrainingStore.pollForUpdate(freeTrainingStore.suggestion?.generatedAt, 20, true)
      }
    } else {
      await recommendationStore.fetchCached()
      if (planRegenTriggered) {
        recommendationStore.pollForUpdate(recommendationStore.recommendation?.generatedAt, 20, true)
      }
    }
    const total = activitiesStore.activities.length
    // "0 new rides added" is the common case and reads like a failure — name it plainly.
    const added = newCount === 0
      ? 'No new rides'
      : `${newCount} new ${newCount === 1 ? 'ride' : 'rides'} added`
    show('success', 'Synced from Garmin', `${added} — ${total} total stored.`)
  } catch {
    show('error', 'Refresh Failed', 'Could not reach the backend.')
  } finally {
    syncing.value = false
  }
}
</script>
