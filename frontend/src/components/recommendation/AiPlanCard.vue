<template>
  <section class="dashboard-card glass-panel" id="sync-card">
    <div class="card-header">
      <i class="fa-solid fa-brain header-icon"></i>
      <h2>AI Training Plan</h2>
      <div v-if="recStore.state === 'loaded'" class="card-header-actions">
        <button class="btn-icon-sm btn-icon-pause" title="Pause training — use for injury, illness or travel" :disabled="pausing" @click="handlePause">
          <i class="fa-solid" :class="pausing ? 'fa-spinner fa-spin' : 'fa-circle-pause'"></i>
        </button>
<button class="btn-icon-sm" title="Refresh recommendation" @click="handleRefresh">
          <i class="fa-solid fa-rotate"></i>
        </button>
      </div>
    </div>
    <div class="card-body">

      <!-- State: not-configured -->
      <div v-show="recStore.state === 'not-configured'" class="ai-rec-state">
        <div class="ai-rec-empty">
          <i class="fa-solid fa-brain ai-rec-empty-icon"></i>
          <p>Add an AI API key in <strong>Connection &amp; Profile</strong>.</p>
          <button class="btn btn-secondary btn-sm" @click="emit('open-settings')">
            <span>Open Settings</span><i class="fa-solid fa-sliders"></i>
          </button>
        </div>
      </div>

      <!-- State: no-plan -->
      <div v-show="recStore.state === 'no-plan'" class="ai-rec-state">
        <div class="ai-rec-empty ai-rec-intro">
          <p class="ai-rec-intro-lead">AI analyses your ride history, heart rate zones and training load to build a continuously adaptive training plan — for as long as you want to train. It always shows the next 7 days ahead, but the plan has no end date: it rolls forward every day and adjusts to what you actually did.</p>
          <ul class="ai-rec-intro-list">
            <li><i class="fa-solid fa-rotate"></i><span><strong>Rolls forward every day.</strong> The plan always starts from today. Each morning a fresh window is generated in the background — no action needed.</span></li>
            <li><i class="fa-solid fa-circle-check"></i><span><strong>Detects what you actually did.</strong> After a Garmin sync, completed workouts are matched to the plan. Zone data shows whether intervals were fully executed, partially done, or the intensity didn't match.</span></li>
            <li><i class="fa-solid fa-forward-step"></i><span><strong>Adapts to skips and changes.</strong> Missed a session? The plan recalculates. Want to move a workout to today? Use the calendar button on any future day.</span></li>
            <li><i class="fa-solid fa-chart-line"></i><span><strong>Builds progression over time.</strong> The AI tracks your compliance and fatigue across weeks, gradually increasing load when you're ready and backing off when you need recovery.</span></li>
          </ul>
          <button class="btn btn-primary" :disabled="generating" @click="handleGenerateFirst">
            <span>{{ generating ? 'Generating…' : 'Generate my first plan' }}</span>
            <i class="fa-solid" :class="generating ? 'fa-spinner fa-spin' : 'fa-wand-magic-sparkles'"></i>
          </button>
        </div>
      </div>

      <!-- State: loading -->
      <div v-show="recStore.state === 'loading'" class="ai-rec-state">
        <div class="ai-rec-loading">
          <i class="fa-solid fa-spinner fa-spin"></i><span>Updating AI Training Plan…</span>
        </div>
      </div>

      <!-- State: paused -->
      <div v-show="recStore.state === 'paused'" class="ai-rec-state">
        <div class="ai-rec-paused">
          <i class="fa-solid fa-circle-pause ai-rec-paused-icon"></i>
          <p class="ai-rec-paused-title">Training paused</p>
          <p v-if="recStore.pauseReason" class="ai-rec-paused-reason">{{ recStore.pauseReason }}</p>
          <p class="ai-rec-paused-since">Paused since {{ formatPausedDate(recStore.pausedSince) }}</p>
          <button class="btn btn-primary btn-sm" :disabled="resuming" @click="handleResume">
            <span>{{ resuming ? 'Resuming…' : 'Resume training' }}</span>
            <i class="fa-solid" :class="resuming ? 'fa-spinner fa-spin' : 'fa-play'"></i>
          </button>
        </div>
      </div>

      <!-- State: loaded -->
      <div v-show="recStore.state === 'loaded'" class="ai-rec-state">
        <template v-if="rec">
          <!-- Week grid + load assessment -->
          <div class="ai-week-section">
            <WeekGrid :plan="rec.weeklyPlan" :todayPriority="rec.priority" @reschedule="handleReschedule" @skip-today="handleSkip" />
            <LoadAssessment v-if="rec.loadAssessment" :assessment="rec.loadAssessment" :generatedAt="rec.generatedAt" />
          </div>

          <!-- Next week -->
          <NextWeekOverview v-if="rec.nextWeekOverview" :overview="rec.nextWeekOverview" />
        </template>
      </div>

      <!-- State: error -->
      <div v-show="recStore.state === 'error'" class="ai-rec-state">
        <div class="ai-rec-error">
          <i class="fa-solid fa-circle-exclamation"></i>
          <p>{{ recStore.errorMessage || 'Failed to get recommendation.' }}</p>
          <button class="btn btn-secondary btn-sm" @click="recStore.fetchCached()">
            <span>OK</span>
          </button>
        </div>
      </div>

      <div class="ai-sync-divider"></div>

      <!-- Sync button -->
      <button
        class="btn btn-primary btn-glow"
        :disabled="!recStore.canSync || syncing"
        @click="handleSync"
      >
        <span>{{ syncing ? 'Syncing Workouts…' : 'Sync &amp; Schedule Workouts' }}</span>
        <i class="fa-solid" :class="syncing ? 'fa-spinner fa-spin' : 'fa-cloud-arrow-up'"></i>
      </button>

      <!-- Sync result -->
      <SyncResult :result="syncResult" />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRecommendationStore } from '@/stores/recommendation.store'
import { useToast }               from '@/composables/useToast'
import { useConfirm }             from '@/composables/useConfirm'
import { usePauseDialog }         from '@/composables/usePauseDialog'
import { useMoveDayDialog }       from '@/composables/useMoveDayDialog'

import type { SyncResult as SyncResultType } from '@/types'

import WeekGrid         from './WeekGrid.vue'
import NextWeekOverview from './NextWeekOverview.vue'
import LoadAssessment   from './LoadAssessment.vue'
import SyncResult       from './SyncResult.vue'

const emit = defineEmits<{ 'open-settings': [] }>()

const recStore  = useRecommendationStore()
const { show }  = useToast()
const { confirm } = useConfirm()
const { promptForReason } = usePauseDialog()
const { pickDay }         = useMoveDayDialog()

const rec = computed(() => recStore.recommendation)

const generating = ref(false)

const pausing    = ref(false)
const resuming   = ref(false)
const syncing    = ref(false)
const syncResult = ref<SyncResultType | null>(null)

function formatPausedDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}

async function handleGenerateFirst() {
  generating.value = true
  await recStore.refresh()
  generating.value = false
}

async function handleRefresh() {
  await recStore.refresh()
  if (recStore.state === 'error') {
    show('error', 'Refresh Failed', recStore.errorMessage)
  }
}

async function handlePause() {
  const reason = await promptForReason()
  if (reason === null) return  // cancelled

  pausing.value = true
  const ok = await recStore.pauseTraining(reason || undefined)
  pausing.value = false
  if (ok) {
    show('info', 'Training paused', 'AI suggestions are suspended. Resume when you\'re ready.')
  } else {
    show('error', 'Pause Failed', 'Could not pause training.')
  }
}

async function handleResume() {
  resuming.value = true
  const ok = await recStore.resumeTraining()
  resuming.value = false
  if (ok) {
    show('success', 'Training resumed', 'AI is generating a fresh plan for your return.')
  } else {
    show('error', 'Resume Failed', 'Could not resume training.')
  }
}

async function handleSkip() {
  const confirmed = await confirm({
    title:        'Skip today\'s workout?',
    message:      'This will mark today as skipped and ask AI to recalculate the rest of your week.',
    confirmLabel: 'Skip workout',
    danger:       true,
  })
  if (!confirmed) return

  const result = await recStore.skipToday()
  if (result === 'ok') {
    show('success', 'Workout skipped', 'Plan updated by AI.')
  } else if (result === 'skipped') {
    show('warn', 'Workout skipped', 'AI refresh temporarily unavailable — plan will update automatically.')
  } else {
    show('error', 'Skip Failed', 'Could not skip today.')
  }
}

async function handleReschedule(fromDate: string) {
  const plan  = rec.value?.weeklyPlan ?? []
  const entry = plan.find(e => e.date === fromDate)
  if (!entry) return

  const toDate = await pickDay(entry, plan)
  if (!toDate) return

  const result = await recStore.reschedule(fromDate, toDate)
  if (result === 'ok') {
    show('success', 'Workout moved', 'Plan updated — AI recalculated the week.')
  } else if (result === 'moved') {
    show('warn', 'Workout moved', 'AI refresh temporarily unavailable — plan will update automatically.')
  } else {
    show('error', 'Move Failed', 'Could not move workout.')
  }
}

async function handleSync() {
  syncing.value    = true
  syncResult.value = null
  const result     = await recStore.syncWorkouts()
  syncing.value    = false

  if (!result) {
    show('error', 'Connection Error', 'Failed to connect to backend sync endpoint.')
    return
  }

  syncResult.value = result

  if (result.usingFallback?.length) {
    show('warn', 'Default structures used',
      `${result.usingFallback.join(', ')} used built-in defaults — regenerate the AI plan for personalised workouts.`)
  }
  result.scheduleErrors?.forEach(msg => show('warn', 'Scheduling incomplete', msg))
}
</script>
