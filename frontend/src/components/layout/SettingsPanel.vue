<template>
  <div class="panel-overlay" :class="{ open: open }" @click="emit('update:open', false)"></div>

  <aside class="settings-panel" :class="{ open: open }">
    <div class="settings-panel-header">
      <div class="settings-panel-title">
        <i class="fa-solid fa-plug"></i>
        <span>Connections</span>
      </div>
      <button class="panel-close-btn" aria-label="Close" @click="emit('update:open', false)">
        <i class="fa-solid fa-xmark"></i>
      </button>
    </div>

    <div class="settings-panel-body">

      <!-- ── Garmin Auth Section ── -->
      <div class="panel-section">
        <div class="panel-section-label">
          <i class="fa-solid fa-key"></i>
          <span>Garmin Connection</span>
        </div>

        <!-- Loading skeleton -->
        <div v-if="!authStore.loaded" id="auth-status-loading">
          <div class="skeleton-line" style="width:65%"></div>
          <div class="skeleton-line" style="width:100%;height:38px;margin-top:12px;border-radius:10px"></div>
          <div class="skeleton-line" style="width:100%;height:38px;margin-top:8px;border-radius:10px"></div>
          <div class="skeleton-line" style="width:100%;height:42px;margin-top:14px;border-radius:10px"></div>
        </div>

        <!-- Logged out -->
        <div v-else-if="!authStore.isLoggedIn">
          <p class="helper-text">Authenticate with your Garmin Connect account to fetch activities and sync workouts.</p>
          <form @submit.prevent="handleLogin">
            <div class="input-group">
              <label for="panel-username">Garmin Email</label>
              <div class="input-wrapper">
                <i class="fa-solid fa-envelope input-icon"></i>
                <input type="email" id="panel-username" v-model="username" placeholder="name@example.com" required>
              </div>
            </div>
            <div class="input-group">
              <label for="panel-password">Password</label>
              <div class="input-wrapper">
                <i class="fa-solid fa-lock input-icon"></i>
                <input type="password" id="panel-password" v-model="password" placeholder="••••••••">
              </div>
            </div>
            <div v-if="authStore.showMfa" class="input-group">
              <label for="panel-mfa" style="color:var(--z4-color)">MFA Verification Code</label>
              <div class="input-wrapper">
                <i class="fa-solid fa-shield-halved input-icon" style="color:var(--z4-color)"></i>
                <input type="text" id="panel-mfa" v-model="mfaCode" placeholder="123456" maxlength="6">
              </div>
              <p class="helper-text">Enter the 6-digit code sent to your email or phone.</p>
            </div>
            <button type="submit" class="btn btn-primary" :disabled="loginBusy">
              <span>{{ loginBusy ? (authStore.showMfa ? 'Verifying…' : 'Connecting…') : 'Connect Garmin' }}</span>
              <i v-if="loginBusy" class="fa-solid fa-spinner fa-spin"></i>
            </button>
          </form>
        </div>

        <!-- Logged in -->
        <div v-else>
          <div class="success-indicator">
            <i class="fa-solid fa-circle-check success-icon"></i>
            <div class="success-details">
              <h3>Garmin Connected</h3>
              <p>You can now sync your Garmin data.</p>
            </div>
          </div>
          <button class="btn btn-secondary" @click="handleLogout">
            <span>Disconnect</span>
          </button>
        </div>
      </div>

      <div class="panel-divider"></div>

      <!-- ── AI Settings Section ── -->
      <div class="panel-section">
        <div class="panel-section-label">
          <i class="fa-solid fa-brain"></i>
          <span>AI Connection</span>
        </div>

        <div v-if="settingsStore.geminiConfigured" style="margin-bottom:0.75rem">
          <div class="success-indicator">
            <i class="fa-solid fa-circle-check success-icon"></i>
            <div class="success-details">
              <h3>Google Gemini Connected</h3>
              <p class="helper-text">{{ settingsStore.maskedKey }}</p>
            </div>
          </div>
          <button class="btn btn-secondary" style="margin-top:0.6rem" @click="handleDisconnectGemini">
            <span>Disconnect</span>
          </button>
        </div>

        <p class="helper-text">
          A <strong>Google Gemini API key</strong> is required to enable adaptive training recommendations.
          Get a free key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener" style="color:var(--primary-color)">aistudio.google.com ↗</a>
        </p>
        <form @submit.prevent>
          <div class="input-group">
            <label for="panel-api-key">API Key</label>
            <div class="input-wrapper">
              <i class="fa-solid fa-key input-icon"></i>
              <input type="password" id="panel-api-key" v-model="apiKey" placeholder="AIza…" autocomplete="off">
            </div>
          </div>

          <div class="input-group" style="margin-top:0.85rem">
            <label for="panel-model">AI Model</label>
            <div class="input-wrapper input-wrapper--select">
              <i class="fa-solid fa-microchip input-icon"></i>
              <select id="panel-model" v-model="selectedModel">
                <option v-for="m in MODEL_PRESETS" :key="m.id" :value="m.id">{{ m.label }}</option>
                <option :value="CUSTOM_MODEL">Custom model ID…</option>
              </select>
            </div>

            <!-- Free text so a Pro model, or one released after this build, can be used
                 without waiting for an app update. -->
            <div v-if="isCustomModel" class="input-wrapper" style="margin-top:0.5rem">
              <i class="fa-solid fa-pen-to-square input-icon"></i>
              <input
                type="text"
                id="panel-model-custom"
                v-model="customModel"
                placeholder="gemini-3.1-pro-preview"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
              >
            </div>

            <p v-if="modelError" class="helper-text settings-error" style="margin-top:0.35rem">
              <i class="fa-solid fa-circle-exclamation"></i> {{ modelError }}
            </p>
            <p v-else class="helper-text" style="margin-top:0.35rem">
              {{ isCustomModel
                ? 'Enter the model ID exactly as Google lists it. Pro models need a paid API key.'
                : 'Free tier models have daily rate limits.' }}
              <a href="https://ai.google.dev/gemini-api/docs/models" target="_blank" rel="noopener" style="color:var(--primary-color)">See all models ↗</a>
            </p>
          </div>

          <div class="input-group" style="margin-top:0.85rem">
            <label class="checkbox-label" for="panel-instant-scoring">
              <input type="checkbox" id="panel-instant-scoring" v-model="instantScoring">
              <span>Re-plan automatically when a ride syncs</span>
            </label>
            <p class="helper-text" style="margin-top:0.35rem">
              Regenerates your plan as soon as a new ride arrives, so its execution score shows up right away.
              Turning this off saves AI calls — the score appears at the next scheduled refresh instead.
              Anything you enter yourself, like a check-in or a ride rating, always takes effect immediately.
            </p>
          </div>

        </form>
      </div>


    </div><!-- /settings-panel-body -->

    <div class="settings-panel-footer">
      <button class="btn btn-primary" :disabled="saveBusy" @click="handleSave">
        <span>{{ saveBusy ? 'Saving…' : 'Save Settings' }}</span>
        <i v-if="saveBusy" class="fa-solid fa-spinner fa-spin"></i>
      </button>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter }   from 'vue-router'
import { useAuthStore }     from '@/stores/auth.store'
import { useSettingsStore } from '@/stores/settings.store'
import { useToast }         from '@/composables/useToast'

const props  = defineProps<{ open: boolean }>()
const emit   = defineEmits<{ 'update:open': [boolean] }>()

const authStore     = useAuthStore()
const settingsStore = useSettingsStore()
const router        = useRouter()
const { show }      = useToast()

// Auth form state
const username = ref('')
const password = ref('')
const mfaCode  = ref('')
const loginBusy = ref(false)

// AI model options. Deliberately a short list: it is a starting point, not a catalogue —
// the dropdown went stale every time Google shipped a model, so anything not listed here
// (Pro tiers, brand-new releases) goes in through "Custom model ID…" instead.
const MODEL_PRESETS = [
  { id: 'gemini-3.6-flash',      label: 'gemini-3.6-flash (Recommended / Default)' },
  { id: 'gemini-3.5-flash-lite', label: 'gemini-3.5-flash-lite (Fastest, lightest quota use)' },
] as const

/** Sentinel `selectedModel` value meaning "use whatever is typed in customModel". */
const CUSTOM_MODEL = '__custom__'

/**
 * Mirrors normalizeModelId/isValidModelId in the backend's gemini.service so a typo is
 * caught here with an actionable message instead of coming back as a generic save failure.
 * The backend still validates — it is the one interpolating this into the request URL.
 */
const normalizeModelId = (raw: string): string =>
  raw.trim().replace(/^models\//i, '').toLowerCase()

const isValidModelId = (id: string): boolean =>
  /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id)

// AI settings form state
const apiKey         = ref('')
const selectedModel  = ref<string>(MODEL_PRESETS[0].id)
const customModel    = ref('')
const modelError     = ref('')
const instantScoring = ref(true)
const saveBusy       = ref(false)

const isCustomModel = computed(() => selectedModel.value === CUSTOM_MODEL)

/** The model ID that will actually be saved, whichever input produced it. */
const resolvedModel = computed(() =>
  isCustomModel.value ? normalizeModelId(customModel.value) : selectedModel.value
)

// Sync form state from store when panel opens. A stored model that is not one of the
// presets — a Pro model, or a preset removed in a later version — must reopen as a custom
// entry rather than silently snapping back to the default.
watch(() => props.open, (isOpen) => {
  if (!isOpen) return
  const stored = settingsStore.geminiModel
  if (MODEL_PRESETS.some(m => m.id === stored)) {
    selectedModel.value = stored
    customModel.value   = ''
  } else {
    selectedModel.value = CUSTOM_MODEL
    customModel.value   = stored
  }
  modelError.value     = ''
  instantScoring.value = settingsStore.instantScoreOnNewActivity
  apiKey.value         = ''
  mfaCode.value        = ''
})

watch([selectedModel, customModel], () => { modelError.value = '' })

// ── Login ─────────────────────────────────────────────────────────────────────

async function handleLogin() {
  loginBusy.value = true
  try {
    if (authStore.showMfa) {
      const ok = await authStore.submitMfa(mfaCode.value.trim())
      if (ok) {
        mfaCode.value = ''
        show('success', 'Garmin Connected', '')
        checkRouting()
      } else {
        show('error', 'MFA Failed', 'Invalid code. Try again.')
      }
    } else {
      const result = await authStore.login(username.value, password.value)
      if (result === 'mfa') {
        show('info', 'MFA Required', 'Enter the 6-digit code sent to your email or phone.')
      } else if (result === 'ok') {
        password.value = ''
        show('success', 'Garmin Connected', '')
        checkRouting()
      } else {
        show('error', 'Login Failed', 'Check your credentials and try again.')
      }
    }
  } finally {
    loginBusy.value = false
  }
}

function handleLogout() {
  authStore.logout()
}

async function handleDisconnectGemini() {
  const ok = await settingsStore.disconnectGemini()
  if (ok) show('success', 'AI Disconnected', 'Google Gemini API key removed.')
  else     show('error', 'Disconnect Failed', 'Could not remove the API key.')
}

// ── Save Settings ─────────────────────────────────────────────────────────────

async function handleSave() {
  const model = resolvedModel.value
  if (!model) {
    modelError.value = 'Enter a model ID, or pick one from the list.'
    return
  }
  if (!isValidModelId(model)) {
    modelError.value = 'That does not look like a Google model ID. Use it exactly as listed, e.g. gemini-3.1-pro-preview.'
    return
  }

  saveBusy.value = true
  try {
    const onSetup = router.currentRoute.value.name === 'setup'
    const success = await settingsStore.saveAll(apiKey.value, model)
    if (!success) {
      show('error', 'Save Failed', 'Could not save settings.')
      return
    }
    await settingsStore.saveInstantScoreOnNewActivity(instantScoring.value)
    apiKey.value = ''
    if (!onSetup) {
      show('success', 'Settings Saved', 'API key and preferences updated.')
      emit('update:open', false)
    } else {
      checkRouting()
    }
  } finally {
    saveBusy.value = false
  }
}

function checkRouting() {
  if (!authStore.isLoggedIn || !settingsStore.geminiConfigured) return
  emit('update:open', false)
  if (!settingsStore.setupComplete) {
    router.push({ name: 'profile-setup' })
  } else {
    router.push({ name: 'dashboard' })
  }
}

</script>

<style scoped>
.settings-error {
  color: var(--z5-color, #ef4444);
}

.settings-error i {
  margin-right: 0.3rem;
}
</style>
