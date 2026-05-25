<template>
  <Teleport to="body" :disabled="!modalMode">
    <div :class="modalMode ? 'ps-modal-backdrop' : ''" v-if="!modalMode || true">
      <div id="view-profile-setup" :class="{ 'ps-modal': modalMode }">
        <div class="setup-card glass-panel ps-card">
          <div class="setup-logo">
            <i class="fa-solid fa-heart-pulse logo-icon" style="color:#ef4444"></i>
            <h1>HR <span>Profile</span></h1>
          </div>
          <p class="setup-tagline">We fetched your Garmin history to suggest your optimal training zones. Review and confirm.</p>

          <!-- Loading state -->
          <div v-if="loadingState === 'loading'" class="ps-state">
            <div class="ps-loading-row">
              <i class="fa-solid fa-spinner fa-spin"></i>
              <span>Fetching your Garmin history…</span>
            </div>
          </div>

          <!-- Form state -->
          <div v-else class="ps-state">

            <!-- Suggestion area -->
            <div class="ps-suggestion-area">
              <div v-if="suggestionState === 'loading'" class="ps-suggestion-loading">
                <i class="fa-solid fa-spinner fa-spin"></i>
                <span>Fetching suggestion from Garmin…</span>
              </div>
              <div v-else-if="suggestionState === 'shown'" class="ps-suggestion-row">
                <div class="ps-suggestion-label">
                  <i class="fa-solid fa-wand-magic-sparkles"></i>
                  <span>
                    Suggestion based on <span>{{ suggestionRides }} ride{{ suggestionRides !== 1 ? 's' : '' }}</span>:
                    Max HR <strong>{{ suggestedMaxHr }}</strong> bpm,
                    LTHR <strong>{{ suggestedLthr }}</strong> bpm
                  </span>
                </div>
                <button type="button" class="btn btn-secondary btn-sm" @click="useSuggestion">
                  <span>Use suggestion</span>
                  <i class="fa-solid fa-arrow-up-to-line"></i>
                </button>
              </div>
            </div>

            <!-- Notice -->
            <div v-if="noticeText" class="ps-notice ps-notice-info">{{ noticeText }}</div>

            <div class="hr-stats-row">
              <div class="hr-stat-box">
                <span class="stat-label">Max HR (bpm)</span>
                <input type="number" class="stat-value-input" min="100" max="250" v-model.number="maxHr">
              </div>
              <div class="hr-stat-box">
                <span class="stat-label">LTHR (bpm)</span>
                <input type="number" class="stat-value-input" min="80" max="230" v-model.number="lthr">
              </div>
            </div>

            <div class="zones-visualizer-container">
              <h3>Training Zones Preview</h3>
              <HrZonesBar :maxHr="maxHr" :lthr="lthr" />
            </div>

            <button class="btn btn-primary btn-glow setup-configure-btn" :disabled="saving" @click="handleConfirm">
              <span>{{ saving ? 'Setting up…' : 'Confirm' }}</span>
              <i class="fa-solid" :class="saving ? 'fa-spinner fa-spin' : 'fa-rocket'"></i>
            </button>
            <button class="btn btn-secondary ps-cancel-btn" @click="handleCancel">
              <span>Cancel</span>
              <i class="fa-solid fa-xmark"></i>
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter }  from 'vue-router'
import { useProfileStore }  from '@/stores/profile.store'
import { useSettingsStore } from '@/stores/settings.store'
import { useActivitiesStore } from '@/stores/activities.store'
import { useToast }    from '@/composables/useToast'
import { calcZones }   from '@/composables/useZones'
import HrZonesBar from '@/components/profile/HrZonesBar.vue'

const props = defineProps<{ modalMode?: boolean }>()
const emit  = defineEmits<{ confirmed: []; cancelled: [] }>()

const router         = useRouter()
const profileStore   = useProfileStore()
const settingsStore  = useSettingsStore()
const activitiesStore = useActivitiesStore()
const { show }       = useToast()

// Form state
const maxHr = ref(profileStore.profile?.maxHr ?? 190)
const lthr  = ref(profileStore.profile?.lthr  ?? 165)

// Suggestion state
type LoadState = 'loading' | 'form'
type SugState  = 'loading' | 'shown' | 'hidden'

const loadingState   = ref<LoadState>('loading')
const suggestionState = ref<SugState>('loading')
const suggestedMaxHr = ref(0)
const suggestedLthr  = ref(0)
const suggestionRides = ref(0)
const noticeText     = ref('')
const saving         = ref(false)

onMounted(async () => {
  const hasCustom = profileStore.profile?.hasCustomOverrides ?? false

  // Populate inputs immediately
  maxHr.value = profileStore.profile?.maxHr ?? 190
  lthr.value  = profileStore.profile?.lthr  ?? 165

  // If user already has a custom profile, show the form straight away
  if (hasCustom) {
    loadingState.value = 'form'
  }

  // Always try to fetch a fresh Garmin suggestion
  try {
    const data = await activitiesStore.syncFromGarmin()
    // syncFromGarmin updates the profile store; grab fresh data
    const analysis = activitiesStore.analysis

    if (analysis?.estimatedMaxHr) {
      const sugMaxHr = analysis.estimatedMaxHr
      const sugLthr  = analysis.estimatedLthr || lthr.value
      const rides    = analysis.totalCyclingRides || 0

      suggestedMaxHr.value  = sugMaxHr
      suggestedLthr.value   = sugLthr
      suggestionRides.value = rides

      if (hasCustom) {
        // Only show the suggestion row when it actually differs from saved values
        if (sugMaxHr !== maxHr.value || sugLthr !== lthr.value) {
          suggestionState.value = 'shown'
        } else {
          suggestionState.value = 'hidden'
        }
      } else {
        // First-time: fill inputs with suggestion
        maxHr.value = sugMaxHr
        lthr.value  = sugLthr
        suggestionState.value = 'shown'
      }
    } else {
      suggestionState.value = 'hidden'
      if (!hasCustom) {
        noticeText.value = 'No Garmin rides yet — using defaults. Adjust to match your fitness level.'
      }
    }
  } catch {
    suggestionState.value = 'hidden'
    if (!hasCustom) {
      noticeText.value = 'Garmin data unavailable — using defaults. You can update at any time.'
    }
  }

  loadingState.value = 'form'
})

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
    const ok      = await profileStore.save(profile)
    if (!ok) {
      show('error', 'Save Failed', 'Could not save HR profile. Please try again.')
      return
    }
    if (props.modalMode) {
      show('success', 'HR Profile Updated', 'Training zones recalculated and saved.')
      emit('confirmed')
    } else {
      // First-time setup: mark complete, load dashboard
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
