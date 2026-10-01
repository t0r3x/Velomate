<template>
  <section class="dashboard-card glass-panel" id="sync-card">
    <div class="card-header">
      <i class="fa-solid fa-brain header-icon"></i>
      <h2>Free Training</h2>
      <div v-if="freeStore.state === 'loaded'" class="card-header-actions">
        <button class="btn-icon-sm btn-icon-pause" title="Pause training — use for injury, illness or travel" :disabled="pausing" @click="handlePause">
          <i class="fa-solid" :class="pausing ? 'fa-spinner fa-spin' : 'fa-circle-pause'"></i>
        </button>
        <button class="btn-icon-sm" title="Refresh suggestion" :disabled="refreshing" @click="handleRefresh">
          <i class="fa-solid" :class="refreshing ? 'fa-spinner fa-spin' : 'fa-rotate'"></i>
        </button>
      </div>
    </div>
    <div class="card-body">
      <!-- Sits above the scroll area, not inside it: how the athlete feels today is the
           first input to everything below, and must not scroll out of view. -->
      <DailyCheckinStrip v-if="freeStore.state === 'loaded'" />

      <div class="card-body-scroll scroll-panel">

      <!-- State: not-configured -->
      <div v-show="freeStore.state === 'not-configured'" class="ai-rec-state">
        <div class="ai-rec-empty">
          <i class="fa-solid fa-brain ai-rec-empty-icon"></i>
          <p>Add an AI API key in <strong>Connection &amp; Profile</strong>.</p>
          <button class="btn btn-secondary btn-sm" @click="emit('open-settings')">
            <span>Open Settings</span><i class="fa-solid fa-sliders"></i>
          </button>
        </div>
      </div>

      <!-- State: no-suggestion -->
      <div v-show="freeStore.state === 'no-suggestion'" class="ai-rec-state">
        <div class="ai-rec-empty ai-rec-intro">
          <p class="ai-rec-intro-lead">Free training gives you one workout at a time instead of a fixed schedule. AI reads your ride history, heart rate zones and training load and answers a single question: what is the best next session for you right now? You decide when to ride it.</p>
          <ul class="ai-rec-intro-list">
            <li><i class="fa-solid fa-calendar-xmark"></i><span><strong>No fixed day.</strong> The suggestion isn't tied to a date. Ride it today, in three days, or ask for a different one — nothing is ever marked as missed.</span></li>
            <li><i class="fa-solid fa-cloud-arrow-up"></i><span><strong>Sync when you're ready.</strong> Push it to Garmin whenever you want. It's named and scheduled for the day you pressed the button, so you can always trace it back.</span></li>
            <li><i class="fa-solid fa-circle-check"></i><span><strong>Learns from what you ride.</strong> The first ride after a sync is matched to the suggestion and scored on zone data, RPE and feeling — the same 0-100 scale the full plan uses.</span></li>
            <li><i class="fa-solid fa-arrows-rotate"></i><span><strong>Always the next best thing.</strong> Not in the mood for intervals? Ask for another suggestion — the AI remembers what you turn down and adjusts.</span></li>
          </ul>
          <button class="btn btn-primary" :disabled="generating" @click="handleGenerateFirst">
            <span>{{ generating ? 'Generating…' : 'Suggest my next workout' }}</span>
            <i class="fa-solid" :class="generating ? 'fa-spinner fa-spin' : 'fa-wand-magic-sparkles'"></i>
          </button>
        </div>
      </div>

      <!-- State: loading -->
      <div v-show="freeStore.state === 'loading'" class="ai-rec-state">
        <div class="ai-rec-loading">
          <i class="fa-solid fa-spinner fa-spin"></i><span>Working out your next session…</span>
        </div>
      </div>

      <!-- State: paused -->
      <div v-show="freeStore.state === 'paused'" class="ai-rec-state">
        <div class="ai-rec-paused">
          <i class="fa-solid fa-circle-pause ai-rec-paused-icon"></i>
          <p class="ai-rec-paused-title">Training paused</p>
          <p v-if="freeStore.pauseReason" class="ai-rec-paused-reason">{{ freeStore.pauseReason }}</p>
          <p class="ai-rec-paused-since">Paused since {{ formatPausedDate(freeStore.pausedSince) }}</p>
          <button class="btn btn-primary btn-sm" :disabled="resuming" @click="handleResume">
            <span>{{ resuming ? 'Resuming…' : 'Resume training' }}</span>
            <i class="fa-solid" :class="resuming ? 'fa-spinner fa-spin' : 'fa-play'"></i>
          </button>
        </div>
      </div>

      <!-- State: loaded -->
      <div v-show="freeStore.state === 'loaded'" class="ai-rec-state">
        <template v-if="suggestion">
          <!-- Inline indicator for a background regen (refresh/dismiss/resume) — the
               suggestion below stays visible while the AI picks the next one. -->
          <p v-if="freeStore.isRegenerating" class="ai-rec-regenerating">
            <i class="fa-solid fa-spinner fa-spin"></i><span>Your next suggestion is on its way…</span>
          </p>

          <div class="week-preview-header">
            <i class="fa-solid" :class="isRest ? 'fa-bed' : 'fa-dumbbell'"></i>
            <span>{{ isRest ? 'Rest Day' : 'Your Next Workout' }}</span>
            <span class="week-label">{{ isRest ? 'Recovery comes first' : 'Ride it whenever suits you' }}</span>
          </div>

          <!-- Same detail panel the weekly plan uses, minus everything date-bound -->
          <WorkoutDetailPanel
            :entry="asPlanEntry"
            :priority="suggestion.priority"
            :dateless="true"
          />

          <p v-if="suggestion.coachNote" class="ft-coach-note">
            <i class="fa-solid fa-clock"></i>
            <span>{{ suggestion.coachNote }}</span>
          </p>

          <!-- Traceability: which day this was pushed to Garmin -->
          <p v-if="freeStore.isSynced && suggestion.syncedForDate" class="ft-synced-note">
            <i class="fa-solid fa-circle-check"></i>
            <span>Synced to Garmin on <strong>{{ formatSyncedDate(suggestion.syncedForDate) }}</strong> — find it under that date in your Garmin calendar. Your next ride will be matched to it.</span>
          </p>

          <LoadAssessment
            v-if="suggestion.loadAssessment"
            :assessment="suggestion.loadAssessment"
            :generatedAt="suggestion.generatedAt"
          />

          <FreeHistoryList :history="freeStore.history" />
        </template>
      </div>

      <!-- State: error -->
      <div v-show="freeStore.state === 'error'" class="ai-rec-state">
        <div class="ai-rec-error">
          <i class="fa-solid fa-circle-exclamation"></i>
          <p>{{ freeStore.errorMessage || 'Failed to get a suggestion.' }}</p>
          <button class="btn btn-secondary btn-sm" @click="freeStore.fetchCached()">
            <span>OK</span>
          </button>
        </div>
      </div>

    </div>

    <!-- Pinned action bar — always visible, never scrolled out of view -->
    <div class="card-pinned-footer ft-footer">
      <button
        class="btn btn-primary"
        :disabled="!freeStore.canSync || syncing"
        :title="syncTitle"
        @click="handleSync"
      >
        <span>{{ syncing ? 'Syncing Workout…' : freeStore.isSynced ? 'Sync Again' : 'Sync &amp; Schedule Workout' }}</span>
        <i class="fa-solid" :class="syncing ? 'fa-spinner fa-spin' : 'fa-cloud-arrow-up'"></i>
      </button>
      <button
        class="btn btn-secondary"
        :disabled="freeStore.state !== 'loaded' || dismissing"
        title="Ask the AI for a different workout"
        @click="handleDismiss"
      >
        <span>{{ dismissing ? 'Rethinking…' : 'Suggest Something Else' }}</span>
        <i class="fa-solid" :class="dismissing ? 'fa-spinner fa-spin' : 'fa-shuffle'"></i>
      </button>
      <SyncResult :result="syncResult" :singleWorkout="true" @close="syncResult = null" />
    </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useFreeTrainingStore } from '@/stores/freeTraining.store'
import { useToast }             from '@/composables/useToast'
import { useConfirm }           from '@/composables/useConfirm'
import { usePauseDialog }       from '@/composables/usePauseDialog'

import type { PlanEntry, SyncResult as SyncResultType } from '@/types'

import WorkoutDetailPanel from './WorkoutDetailPanel.vue'
import LoadAssessment     from './LoadAssessment.vue'
import FreeHistoryList    from './FreeHistoryList.vue'
import SyncResult         from './SyncResult.vue'
import DailyCheckinStrip from '@/components/checkin/DailyCheckinStrip.vue'

const emit = defineEmits<{ 'open-settings': [] }>()

const freeStore = useFreeTrainingStore()
const { show }            = useToast()
const { confirm }         = useConfirm()
const { promptForReason } = usePauseDialog()

const suggestion = computed(() => freeStore.suggestion)

/** Rest is not a workout, and the card must not keep calling it one. */
const isRest = computed(() => suggestion.value?.workoutType === 'Rest')

/**
 * Adapt the suggestion to the shape WorkoutDetailPanel expects. An empty date is the
 * point: `dateless` hides the day label and the date-bound Skip/Move actions, leaving the
 * zone bar, step list, duration and reason — exactly the parts free mode needs.
 */
const asPlanEntry = computed<PlanEntry>(() => ({
  date:      '',
  type:      suggestion.value?.workoutType ?? 'Rest',
  reason:    suggestion.value?.reason ?? '',
  status:    'planned',
  structure: suggestion.value?.structure ?? null,
}))

const syncTitle = computed(() => {
  if (!freeStore.isSyncable) return 'Rest days have no workout to sync'
  if (!freeStore.canSync)    return 'Connect Garmin to sync workouts'
  return 'Upload and schedule this workout on today’s date'
})

const generating = ref(false)
const pausing    = ref(false)
const resuming   = ref(false)
const refreshing = ref(false)
const syncing    = ref(false)
const dismissing = ref(false)
const syncResult = ref<SyncResultType | null>(null)

function formatPausedDate(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}

function formatSyncedDate(date: string): string {
  return new Date(date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
}

async function handleGenerateFirst() {
  generating.value = true
  await freeStore.refresh()
  generating.value = false
}

async function handleRefresh() {
  refreshing.value = true
  await freeStore.refresh()
  refreshing.value = false
  if (freeStore.state === 'error') {
    show('error', 'Refresh Failed', freeStore.errorMessage)
  }
}

async function handleDismiss() {
  const confirmed = await confirm({
    title:        'Suggest something else?',
    message:      'The AI will replace this workout with a different one and remember that you passed on it.',
    confirmLabel: 'Suggest another',
  })
  if (!confirmed) return

  dismissing.value = true
  const result = await freeStore.dismiss()
  dismissing.value = false

  if (result === 'ok') {
    show('success', 'Suggestion dismissed', 'Picking a different workout…')
  } else {
    show('error', 'Failed', 'Could not get a different suggestion.')
  }
}

async function handlePause() {
  const reason = await promptForReason()
  if (reason === null) return  // cancelled

  pausing.value = true
  const ok = await freeStore.pauseTraining(reason || undefined)
  pausing.value = false
  if (ok) {
    show('info', 'Training paused', 'AI suggestions are suspended. Resume when you\'re ready.')
  } else {
    show('error', 'Pause Failed', 'Could not pause training.')
  }
}

async function handleResume() {
  resuming.value = true
  const ok = await freeStore.resumeTraining()
  resuming.value = false
  if (ok) {
    show('success', 'Training resumed', 'A fresh suggestion is being worked out for your return.')
  } else {
    show('error', 'Resume Failed', 'Could not resume training.')
  }
}

async function handleSync() {
  syncing.value    = true
  syncResult.value = null
  const result     = await freeStore.syncWorkout()
  syncing.value    = false

  if (!result) {
    show('error', 'Sync Failed', 'Could not upload the workout to Garmin.')
    return
  }

  syncResult.value = result

  if (result.usingFallback?.length) {
    show('warn', 'Default structure used',
      `${result.usingFallback.join(', ')} used a built-in default — refresh the suggestion for a personalised workout.`)
  }
  result.scheduleErrors?.forEach(msg => show('warn', 'Scheduling incomplete', msg))
}
</script>

<style scoped>
/* Two actions share the footer here, unlike the plan card's single sync button. */
.ft-footer {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.ft-footer .btn {
  flex: 1 1 auto;
}

.ft-coach-note,
.ft-synced-note {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  margin: 0.75rem 0 0;
  padding: 0.6rem 0.75rem;
  border-radius: 0.5rem;
  font-size: 0.8rem;
  line-height: 1.5;
}

.ft-coach-note {
  background: rgba(var(--primary-rgb), 0.08);
  border: 1px solid rgba(var(--primary-rgb), 0.18);
  color: var(--text-secondary);
}

.ft-synced-note {
  background: rgba(16, 185, 129, 0.08);
  border: 1px solid rgba(16, 185, 129, 0.2);
  color: var(--text-secondary);
}

.ft-coach-note i,
.ft-synced-note i {
  margin-top: 0.15rem;
  flex-shrink: 0;
}

.ft-coach-note i { color: var(--primary-color); }
.ft-synced-note i { color: #10b981; }
</style>
