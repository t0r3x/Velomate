<template>
  <div class="tp-backdrop" :class="{ 'tp-modal-mode': modalMode }" @click.self="modalMode ? handleCancel() : undefined">
      <div class="tp-panel glass-panel">

        <!-- Header -->
        <div class="tp-header">
          <div class="tp-title">
            <i class="fa-solid fa-user-gear tp-title-icon"></i>
            <span>Training Profile</span>
          </div>
          <button v-if="modalMode" class="panel-close-btn" aria-label="Close" @click="handleCancel">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>

        <!-- Body -->
        <div class="tp-body">

          <!-- Loading -->
          <div v-if="loadingState === 'loading'" class="ps-state">
            <div class="ps-loading-row">
              <i class="fa-solid fa-spinner fa-spin"></i>
              <span>Fetching your Garmin history…</span>
            </div>
          </div>

          <template v-else>

            <!-- ── Heart Rate Profile ── -->
            <div class="tp-section-label">
              <i class="fa-solid fa-heart-pulse" style="color: var(--z5-color)"></i>
              Heart Rate Profile
            </div>

            <div v-if="suggestionState !== 'hidden'" class="ps-suggestion-row">
              <div class="ps-suggestion-label">
                <i class="fa-solid fa-wand-magic-sparkles"></i>
                <span v-if="suggestionState === 'loading'" class="ps-suggestion-placeholder">Fetching Garmin history for suggestion…</span>
                <span v-else>
                  Derived from your data:
                  Max HR <strong>{{ suggestedMaxHr }}</strong> bpm, LTHR <strong>{{ suggestedLthr }}</strong> bpm
                </span>
              </div>
              <button type="button" class="btn btn-secondary btn-sm" :disabled="suggestionState === 'loading'" @click="useSuggestion">
                <span>Use suggestion</span>
                <i class="fa-solid fa-arrow-up-to-line"></i>
              </button>
            </div>

            <div v-if="noticeText" class="ps-notice ps-notice-info">{{ noticeText }}</div>

            <div class="hr-stats-row">
              <div class="hr-stat-box">
                <span class="stat-label">Max HR (bpm)</span>
                <input type="number" class="stat-value-input" min="100" max="250" v-model.number="maxHr">
              </div>
              <button type="button" class="hr-recalc-btn" title="Recalculate LTHR as 88% of Max HR" @click="recalcLthr">
                <i class="fa-solid fa-arrow-right"></i>
                <span class="hr-recalc-label">88%</span>
              </button>
              <div class="hr-stat-box">
                <span class="stat-label">LTHR (bpm)</span>
                <input type="number" class="stat-value-input" min="80" max="230" v-model.number="lthr">
              </div>
            </div>

            <div class="zones-visualizer-container">
              <h3>Training Zones Preview</h3>
              <p class="helper-text zones-hr-note">
                <i class="fa-solid fa-circle-info"></i>
                Make sure these zones match the ones on your heart rate monitor (e.g. Garmin) — drag a boundary between two zones to adjust it manually.
              </p>
              <HrZonesBar :zones="zones" :maxHr="maxHr" @update:zones="zones = $event" />
            </div>

            <!-- ── Preferred Long Ride Days ── -->
            <div class="tp-section-label tp-section-divider">
              <i class="fa-solid fa-calendar-week"></i>
              Preferred Long Ride Days
            </div>
            <div class="preferred-days-grid">
              <label v-for="day in ALL_DAYS" :key="day.value" class="day-chip">
                <input type="checkbox" :value="day.value" v-model="selectedDays">
                <span>{{ day.label }}</span>
              </label>
            </div>
            <p class="helper-text" style="margin-top: 0.35rem">The AI will prefer these days for long endurance rides.</p>

            <!-- ── Goals & Preferences ── -->
            <div class="tp-section-label tp-section-divider">
              <i class="fa-solid fa-bullseye"></i>
              Goals &amp; Preferences
            </div>
            <textarea
              v-model="goals"
              class="goals-textarea"
              placeholder="e.g. Build stamina for a 100 km ride in August, no more than 3 sessions a week, etc."
              maxlength="500"
              rows="3"
            ></textarea>
            <p class="helper-text" style="margin-top: 0.35rem">Share your goals, events, or constraints. The AI uses this as secondary input alongside your training data.</p>

            <!-- ── Auto-pause ── -->
            <div class="tp-section-label tp-section-divider">
              <i class="fa-solid fa-clock"></i>
              Auto-pause
            </div>
            <div class="hr-stats-row" style="align-items:center;gap:0.75rem">
              <label for="ps-inactivity-days" class="helper-text" style="margin:0;flex:1">Pause training after this many consecutive days without a recorded workout:</label>
              <input
                type="number"
                id="ps-inactivity-days"
                v-model.number="inactivityPauseDays"
                min="1"
                max="365"
                step="1"
                class="stat-value-input"
                style="width:72px;text-align:center"
              >
            </div>

          </template>
        </div>

        <!-- Footer -->
        <div class="tp-footer">
          <button class="btn btn-primary" :disabled="saving || loadingState === 'loading'" @click="handleConfirm">
            <span>{{ saving ? 'Saving…' : 'Save Profile' }}</span>
            <i class="fa-solid" :class="saving ? 'fa-spinner fa-spin' : 'fa-floppy-disk'"></i>
          </button>
        </div>

      </div>
    </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import { useRouter }  from 'vue-router'
import { useProfileStore }  from '@/stores/profile.store'
import { useSettingsStore } from '@/stores/settings.store'
import { useActivitiesStore } from '@/stores/activities.store'
import { useToast }    from '@/composables/useToast'
import { calcZones }   from '@/composables/useZones'
import type { HrZones } from '@/types'
import { getTrainingGoals, postTrainingGoals } from '@/api/client'
import HrZonesBar from '@/components/profile/HrZonesBar.vue'

const ALL_DAYS = [
  { value: 'Monday',    label: 'Mon' },
  { value: 'Tuesday',   label: 'Tue' },
  { value: 'Wednesday', label: 'Wed' },
  { value: 'Thursday',  label: 'Thu' },
  { value: 'Friday',    label: 'Fri' },
  { value: 'Saturday',  label: 'Sat' },
  { value: 'Sunday',    label: 'Sun' }
]

const props = defineProps<{ modalMode?: boolean }>()
const emit  = defineEmits<{ confirmed: []; cancelled: [] }>()

const router         = useRouter()
const profileStore   = useProfileStore()
const settingsStore  = useSettingsStore()
const activitiesStore = useActivitiesStore()
const { show }       = useToast()

// Form state
const maxHr        = ref(profileStore.profile?.maxHr ?? 190)
const lthr         = ref(profileStore.profile?.lthr  ?? 165)
// Zones start from a previously-saved custom shape if one exists, else the LTHR-formula
// baseline. Can then be dragged (HrZonesBar) to deviate from it — see the watcher below
// for when the baseline gets reapplied.
const zones        = ref<HrZones>(profileStore.profile?.zones ?? calcZones(lthr.value, maxHr.value))
const selectedDays        = ref<string[]>([...settingsStore.preferredLongRideDays])
const goals               = ref('')
const inactivityPauseDays = ref(settingsStore.inactivityPauseDays)

// Suggestion state
type LoadState = 'loading' | 'form'
type SugState  = 'loading' | 'shown' | 'hidden'

const loadingState   = ref<LoadState>('loading')
const suggestionState = ref<SugState>('loading')
const suggestedMaxHr = ref(0)
const suggestedLthr  = ref(0)
const noticeText     = ref('')
const saving         = ref(false)

// Recompute the formula baseline whenever Max HR / LTHR change (initial load, "Use
// suggestion", the 88% recalc button). A manual drag on HrZonesBar only updates `zones`
// directly and doesn't touch maxHr/lthr, so it isn't undone by this watcher.
watch([maxHr, lthr], ([newMaxHr, newLthr]) => {
  zones.value = calcZones(newLthr, newMaxHr)
})

onMounted(async () => {
  const hasCustom = profileStore.profile?.hasCustomOverrides ?? false

  maxHr.value        = profileStore.profile?.maxHr ?? 190
  lthr.value         = profileStore.profile?.lthr  ?? 165
  selectedDays.value = [...settingsStore.preferredLongRideDays]

  try {
    const data = await getTrainingGoals()
    goals.value = data.goals ?? ''
  } catch { /* non-fatal */ }

  if (hasCustom) {
    loadingState.value = 'form'
  }

  try {
    await activitiesStore.syncFromGarmin()
    const analysis = activitiesStore.analysis

    if (analysis?.estimatedMaxHr) {
      const sugMaxHr = analysis.estimatedMaxHr
      const sugLthr  = analysis.estimatedLthr || lthr.value

      suggestedMaxHr.value = sugMaxHr
      suggestedLthr.value  = sugLthr

      if (!hasCustom) {
        maxHr.value = sugMaxHr
        lthr.value  = sugLthr
      }
      suggestionState.value = 'shown'
    } else {
      suggestionState.value = 'hidden'
      if (!hasCustom) noticeText.value = 'No Garmin rides yet — using defaults. Adjust to match your fitness level.'
    }
  } catch {
    suggestionState.value = 'hidden'
    if (!hasCustom) noticeText.value = 'Garmin data unavailable — using defaults. You can update at any time.'
  }

  loadingState.value = 'form'
})

function recalcLthr() {
  lthr.value = Math.round(maxHr.value * 0.88)
  // Force the reset even if lthr's numeric value happens to be unchanged (e.g. after
  // a manual zone drag) — the watcher below only fires on an actual value change.
  zones.value = calcZones(lthr.value, maxHr.value)
}

function useSuggestion() {
  maxHr.value = suggestedMaxHr.value
  lthr.value  = suggestedLthr.value
  zones.value = calcZones(lthr.value, maxHr.value)
  suggestionState.value = 'hidden'
}

async function handleConfirm() {
  saving.value = true
  try {
    const profile = { maxHr: maxHr.value, lthr: lthr.value, zones: zones.value, hasCustomOverrides: true }
    const [ok] = await Promise.all([
      profileStore.save(profile),
      settingsStore.savePreferredDays(selectedDays.value),
      settingsStore.saveInactivityPauseDays(inactivityPauseDays.value),
      postTrainingGoals(goals.value).catch(() => {})
    ])
    if (!ok) {
      show('error', 'Save Failed', 'Could not save profile. Please try again.')
      return
    }
    if (props.modalMode) {
      show('success', 'Training Profile Updated', 'Zones, preferences and goals saved.')
      emit('confirmed')
    } else {
      await settingsStore.markSetupComplete()
      await activitiesStore.loadFromDb()
      router.push({ name: 'dashboard' })
    }
  } finally {
    saving.value = false
  }
}

function handleCancel() {
  if (props.modalMode) {
    emit('cancelled')
  } else {
    router.push({ name: 'setup' })
  }
}
</script>
