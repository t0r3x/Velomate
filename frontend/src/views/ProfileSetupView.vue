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
                Make sure these zones match the ones on your heart rate monitor (e.g. Garmin). Drag a boundary between two zones to adjust it manually.
              </p>
              <HrZonesBar :zones="zones" :maxHr="maxHr" @update:zones="zones = $event" />
            </div>

            <!-- ── Power ── -->
            <div class="tp-section-label tp-section-divider">
              <i class="fa-solid fa-bolt"></i>
              Power
            </div>

            <div v-for="sug in ftpSuggestions" :key="sug.key" class="ps-suggestion-row">
              <div class="ps-suggestion-label">
                <i class="fa-solid fa-wand-magic-sparkles"></i>
                <span v-html="sug.html"></span>
              </div>
              <button type="button" class="btn btn-secondary btn-sm" @click="ftp = sug.value; ftpTouched = true">
                <span>{{ sug.button }}</span>
              </button>
            </div>

            <div class="hr-stats-row">
              <div class="hr-stat-box">
                <span class="stat-label">FTP (W)</span>
                <input type="number" class="stat-value-input" :min="FTP_MIN" :max="FTP_MAX" placeholder="Optional" v-model.number="ftp" @input="ftpTouched = true">
              </div>
            </div>
            <p class="helper-text tp-hint">
              FTP is roughly the power you can hold for an hour. Only rides with a power meter use it: the
              coach reads power next to heart rate to check what you actually rode.
              {{ ftpFollowsGarmin ? 'Taken from Garmin, and kept up to date from it until you change it.' : '' }}
              Workouts on Garmin keep heart rate targets, so they work on every bike.
            </p>

            <!-- ── Training Mode ── -->
            <div class="tp-section-label tp-section-divider">
              <i class="fa-solid fa-shuffle"></i>
              Training Mode
            </div>
            <label class="checkbox-label" for="ps-free-training">
              <input type="checkbox" id="ps-free-training" v-model="freeTrainingMode">
              <span>Free training mode</span>
            </label>
            <p class="helper-text tp-hint">
              Replaces the two-week schedule with a single suggestion for your next workout, with no fixed day.
              Ride it whenever suits you and sync it to Garmin when you're ready.
              Your weekly plan is kept, so you can switch back at any time.
            </p>

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
            <p class="helper-text tp-hint">
              {{ freeTrainingMode
                ? 'Not used in free training mode. There is no schedule to place long rides on; you pick the day yourself.'
                : 'The AI will prefer these days for long endurance rides.' }}
            </p>

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
            <p class="helper-text tp-hint">Share your goals, events, or constraints. The AI uses this as secondary input alongside your training data.</p>

            <!-- ── Auto-pause ── -->
            <div class="tp-section-label tp-section-divider">
              <i class="fa-solid fa-clock"></i>
              Auto-pause
            </div>
            <div class="ps-autopause-row">
              <label for="ps-inactivity-days" class="helper-text">Pause training after this many consecutive days without a recorded workout:</label>
              <input
                type="number"
                id="ps-inactivity-days"
                v-model.number="inactivityPauseDays"
                min="1"
                max="365"
                step="1"
                class="ps-autopause-input"
              >
            </div>

          </template>
        </div>

        <!-- Footer -->
        <div class="tp-footer">
          <button class="btn btn-primary" :disabled="saving || loadingState === 'loading'" @click="handleConfirm">
            <span>{{ saving ? 'Saving…' : 'Save Profile' }}</span>
            <i v-if="saving" class="fa-solid fa-spinner fa-spin"></i>
          </button>
        </div>

      </div>
    </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
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
const freeTrainingMode    = ref(settingsStore.freeTrainingMode)
// '' when the field is emptied (v-model.number leaves a blank input as a string)
const ftp                 = ref<number | '' | null>(profileStore.profile?.ftp ?? null)
// Set by typing or by a suggestion button. Until then the field mirrors the stored FTP, and
// saving leaves the FTP alone: sending the value back unchanged would turn an FTP that follows
// Garmin into a manual one whenever Garmin updated it after this form was filled.
const ftpTouched          = ref(false)

const FTP_MIN = 50
const FTP_MAX = 600

const ftpValue = computed<number | null>(() =>
  typeof ftp.value === 'number' && Number.isFinite(ftp.value) && ftp.value > 0 ? Math.round(ftp.value) : null)

const ftpFollowsGarmin = computed(() => {
  const p = profileStore.profile
  return p?.ftpSource === 'garmin' && p.garminFtp != null && ftpValue.value === p.garminFtp
})

/**
 * Where an FTP could come from, offered only when it differs from what is in the field.
 * Garmin's comes first: the Edge works it out from real efforts. The 20-minute estimate is
 * only as good as the effort behind it, and the text says so.
 */
const ftpSuggestions = computed(() => {
  const p = profileStore.profile
  const out: { key: string; html: string; value: number; button: string }[] = []
  if (p?.garminFtp && p.garminFtp !== ftpValue.value) {
    out.push({ key: 'garmin', value: p.garminFtp, button: "Use Garmin's",
      html: `Garmin reports an FTP of <strong>${p.garminFtp}</strong> W` })
  }
  // A 20-minute best is a lower bound: easy rides say nothing about what the athlete can hold.
  // So it is only offered when there is no FTP, or when it shows the FTP is too LOW (same 3%
  // margin as the coach's FTP CALIBRATION line), never to lower one.
  const current = ftpValue.value
  if (p?.estimatedFtp && p.best20Power && p.estimatedFtp !== p.garminFtp &&
      (current == null || p.estimatedFtp > current * 1.03)) {
    out.push({ key: 'estimate', value: p.estimatedFtp, button: 'Use estimate',
      html: `Your best 20 minutes in the last 90 days was <strong>${p.best20Power}</strong> W, which puts FTP around <strong>${p.estimatedFtp}</strong> W. Only accurate after an all-out 20-minute effort.` })
  }
  return out
})

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
  selectedDays.value      = [...settingsStore.preferredLongRideDays]
  freeTrainingMode.value  = settingsStore.freeTrainingMode

  try {
    const data = await getTrainingGoals()
    goals.value = data.goals ?? ''
  } catch { /* non-fatal */ }

  if (hasCustom) {
    loadingState.value = 'form'
  }

  try {
    await activitiesStore.syncFromGarmin()
    // The sync can bring Garmin's FTP in for the first time.
    if (!ftpTouched.value) ftp.value = profileStore.profile?.ftp ?? null
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
      if (!hasCustom) noticeText.value = 'No Garmin rides yet, so defaults are used. Adjust them to match your fitness level.'
    }
  } catch {
    suggestionState.value = 'hidden'
    if (!hasCustom) noticeText.value = 'Garmin data unavailable, so defaults are used. You can update them at any time.'
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
  if (ftpValue.value != null && (ftpValue.value < FTP_MIN || ftpValue.value > FTP_MAX)) {
    show('error', 'Check your FTP', `FTP must be between ${FTP_MIN} and ${FTP_MAX} W, or left empty.`)
    return
  }
  // Checked here because the input is not inside a <form>, so its min/max are never enforced,
  // and the backend's 400 used to disappear behind a "Training Profile Updated" toast.
  const pauseDays = Number(inactivityPauseDays.value)
  if (!Number.isInteger(pauseDays) || pauseDays < 1 || pauseDays > 365) {
    show('error', 'Check auto-pause', 'Auto-pause must be a whole number of days between 1 and 365.')
    return
  }
  saving.value = true
  try {
    const profile = {
      maxHr: maxHr.value, lthr: lthr.value, zones: zones.value, hasCustomOverrides: true,
      // Absent = leave the stored FTP alone (see ftpTouched); null clears it.
      ...(ftpTouched.value ? { ftp: ftpValue.value } : {}),
    }
    // Captured before saving — switching mode swaps out the whole training card, so it is
    // worth calling out in the toast rather than letting the dashboard silently change shape.
    const modeChanged = freeTrainingMode.value !== settingsStore.freeTrainingMode
    const [ok, daysOk, pauseOk, modeOk, goalsOk] = await Promise.all([
      profileStore.save(profile),
      settingsStore.savePreferredDays(selectedDays.value),
      settingsStore.saveInactivityPauseDays(pauseDays),
      modeChanged ? settingsStore.saveFreeTrainingMode(freeTrainingMode.value) : Promise.resolve(true),
      postTrainingGoals(goals.value).then(() => true).catch(() => false)
    ])
    if (!ok) {
      show('error', 'Save Failed', 'Could not save profile. Please try again.')
      return
    }
    // Each part saves on its own; say which ones did not, instead of reporting success.
    const failed = [
      !daysOk  && 'long ride days',
      !pauseOk && 'auto-pause',
      !modeOk  && 'training mode',
      !goalsOk && 'goals',
    ].filter(Boolean)
    if (failed.length) {
      show('error', 'Partly saved', `Your zones were saved, but ${failed.join(', ')} could not be. Please try again.`)
      return
    }
    if (props.modalMode) {
      if (modeChanged) {
        show('success', freeTrainingMode.value ? 'Free training mode on' : 'Free training mode off',
          freeTrainingMode.value
            ? 'Your weekly plan is kept safe. Ask for your next workout whenever you like.'
            : 'Back to the two-week AI plan. Refresh it to bring it up to date.')
      } else {
        show('success', 'Training Profile Updated', 'Zones, power, preferences and goals saved.')
      }
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
