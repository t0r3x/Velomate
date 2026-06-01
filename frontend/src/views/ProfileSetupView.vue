<template>
  <div class="tp-backdrop" :class="{ 'tp-modal-mode': modalMode }">
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
                  Derived from your peak recorded data:
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
              <HrZonesBar :maxHr="maxHr" :lthr="lthr" />
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
              placeholder="e.g. race in 6 weeks, 100 km ride in 8 weeks, no riding on Sundays…"
              maxlength="500"
              rows="3"
            ></textarea>
            <p class="helper-text" style="margin-top: 0.35rem">Share your goals, events, or constraints. The AI uses this as secondary input alongside your training data.</p>

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
import { ref, onMounted } from 'vue'
import { useRouter }  from 'vue-router'
import { useProfileStore }  from '@/stores/profile.store'
import { useSettingsStore } from '@/stores/settings.store'
import { useActivitiesStore } from '@/stores/activities.store'
import { useToast }    from '@/composables/useToast'
import { calcZones }   from '@/composables/useZones'
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
const selectedDays = ref<string[]>([...settingsStore.preferredLongRideDays])
const goals        = ref('')

// Suggestion state
type LoadState = 'loading' | 'form'
type SugState  = 'loading' | 'shown' | 'hidden'

const loadingState   = ref<LoadState>('loading')
const suggestionState = ref<SugState>('loading')
const suggestedMaxHr = ref(0)
const suggestedLthr  = ref(0)
const noticeText     = ref('')
const saving         = ref(false)

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
    const data = await activitiesStore.syncFromGarmin()
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
}

function useSuggestion() {
  maxHr.value = suggestedMaxHr.value
  lthr.value  = suggestedLthr.value
  suggestionState.value = 'hidden'
}

async function handleConfirm() {
  saving.value = true
  try {
    const zones   = calcZones(lthr.value, maxHr.value)
    const profile = { maxHr: maxHr.value, lthr: lthr.value, zones, hasCustomOverrides: true }
    const [ok] = await Promise.all([
      profileStore.save(profile),
      settingsStore.savePreferredDays(selectedDays.value),
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
