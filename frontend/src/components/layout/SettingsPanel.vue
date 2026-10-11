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
        <div v-else class="panel-stack">
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

      <!-- ── AI Settings Section ── -->
      <div class="panel-section">
        <div class="panel-section-label">
          <i class="fa-solid fa-brain"></i>
          <span>AI Connection</span>
        </div>

        <div v-if="settingsStore.geminiConfigured" class="panel-stack panel-stack--spaced">
          <div class="success-indicator">
            <i class="fa-solid fa-circle-check success-icon"></i>
            <div class="success-details">
              <h3>Google Gemini Connected</h3>
              <p class="helper-text">{{ settingsStore.maskedKey }}</p>
            </div>
          </div>
          <button class="btn btn-secondary" @click="handleDisconnectGemini">
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

          <!-- A choice between trade-offs, not a model catalogue: each card says what the
               athlete gets — how long a plan takes, how carefully it is reasoned, how much of
               the free daily allowance it uses. The model ID is secondary. -->
          <div class="input-group">
            <label id="model-choice-label">AI Model</label>
            <div class="model-choice" role="radiogroup" aria-labelledby="model-choice-label">
              <!-- A div with role="radio", not a <button>: the Custom card holds a text input,
                   and an input inside a button is invalid and swallows its clicks. -->
              <div
                v-for="m in MODEL_CHOICES"
                :key="m.value"
                role="radio"
                tabindex="0"
                class="model-card"
                :class="{ 'is-selected': selectedModel === m.value }"
                :aria-checked="selectedModel === m.value"
                @click="selectModel(m.value)"
                @keydown.enter.prevent="selectModel(m.value)"
                @keydown.space.prevent="selectModel(m.value)"
              >
                <span class="model-card-head">
                  <i class="fa-solid model-card-icon" :class="m.icon"></i>
                  <span class="model-card-title">{{ m.title }}</span>
                  <i v-if="selectedModel === m.value" class="fa-solid fa-circle-check model-card-check"></i>
                </span>
                <span v-if="m.tag" class="model-card-tag">{{ m.tag }}</span>
                <span v-if="m.id" class="model-card-id">{{ m.id }}</span>
                <span class="model-card-desc">{{ m.description }}</span>

                <!-- Free text so a Pro model, or one released after this build, can be used
                     without waiting for an app update. Always visible, so the card shows what
                     choosing it means; disabled until the card is chosen. -->
                <span v-if="m.value === CUSTOM_MODEL" class="model-card-foot">
                  <input
                    ref="customInput"
                    v-model="customModel"
                    type="text"
                    id="panel-model-custom"
                    class="model-card-input"
                    placeholder="gemini-3.1-pro-preview"
                    aria-label="Custom model ID"
                    autocomplete="off"
                    autocapitalize="off"
                    spellcheck="false"
                    :disabled="!isCustomModel"
                    @keydown.space.stop
                    @keydown.enter.stop
                  >
                </span>
              </div>
            </div>

            <p v-if="modelError" class="helper-text settings-error">
              <i class="fa-solid fa-circle-exclamation"></i> {{ modelError }}
            </p>
            <p v-else-if="isCustomModel" class="helper-text">
              Enter the model ID exactly as Google lists it. Pro models need a paid API key.
              <a href="https://ai.google.dev/gemini-api/docs/models" target="_blank" rel="noopener" style="color:var(--primary-color)">See all models ↗</a>
            </p>
            <!-- The practical reason to switch: Google's models get busy (503) or hit their
                 daily limit (429), and then the other one usually still answers. -->
            <p v-else class="helper-text">
              You can switch at any time. Try another model if the selected one is busy or not responding.
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
import { computed, nextTick, ref, watch } from 'vue'
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
  { id: 'gemini-3.8-flash' },
  { id: 'gemini-3.5-flash-lite' },
] as const

/** Sentinel `selectedModel` value meaning "use whatever is typed in customModel". */
const CUSTOM_MODEL = '__custom__'

/**
 * The three cards. Figures are measured on this app's own plan prompt, not vendor claims:
 * flash took 20-80s per plan (minutes when Google was busy), flash-lite 2-5s — and in real
 * calls lite followed the coaching rules less strictly (the backend's sanitizeStructure
 * corrects the workouts either way). Say what the athlete gets, so the choice is a choice.
 */
const MODEL_CHOICES: {
  value: string; id: string | null; title: string; tag?: string; icon: string
  description: string
}[] = [
  {
    value: 'gemini-3.8-flash', id: 'gemini-3.8-flash', title: 'Accurate', tag: 'Recommended', icon: 'fa-bullseye',
    description: 'Weighs your rides, check-ins and recovery most carefully. Worth the wait for a plan you follow every day.',
  },
  {
    value: 'gemini-3.5-flash-lite', id: 'gemini-3.5-flash-lite', title: 'Super fast', icon: 'fa-bolt',
    description: 'A new plan in seconds. Reasons less deeply and follows the coaching rules a little more loosely. Every workout is still checked before it goes to Garmin.',
  },
  {
    value: CUSTOM_MODEL, id: null, title: 'Custom', icon: 'fa-sliders',
    description: 'Any Gemini model by its ID: a Pro model with a paid key, or one released after this version of Velomate.',
  },
]

const customInput = ref<HTMLInputElement[] | HTMLInputElement | null>(null)

/** Pick a card; choosing Custom puts the cursor straight into its (now enabled) field. */
function selectModel(value: string) {
  if (selectedModel.value === value) return
  selectedModel.value = value
  if (value === CUSTOM_MODEL) {
    nextTick(() => {
      const el = Array.isArray(customInput.value) ? customInput.value[0] : customInput.value
      el?.focus()
    })
  }
}

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
    apiKey.value = ''
    if (!onSetup) {
      show('success', 'Settings Saved', 'API key and model updated.')
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
/* A status block and its action, one fixed distance apart — the same in every section.
   Garmin and Gemini used to differ (0.5rem vs 1.1rem) through ad-hoc inline margins. */
.panel-stack {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.75rem;
}
.panel-stack > .success-indicator {
  align-self: stretch;
  margin: 0;
}
/* Before the key help text and form that follow it in the AI section: the form's own gap. */
.panel-stack--spaced { margin-bottom: 1.25rem; }
/* The masked key reuses .helper-text, whose bottom margin made the Gemini block taller
   than the Garmin one. */
.success-indicator .helper-text { margin-bottom: 0; }

/* Model choice: three cards, a radio group. Selection is an accent outline and a check —
   never a fill, the same rule as the selected week day. */
.model-choice {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.75rem;
}
.model-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.35rem;
  padding: 1rem;
  text-align: left;
  font: inherit;
  color: var(--text-primary);
  background: var(--surface-2);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}
.model-card:hover { border-color: var(--hairline-strong); }
.model-card:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary-color) 18%, transparent);
}
.model-card.is-selected {
  border-color: var(--primary-color);
  box-shadow: inset 0 0 0 1px var(--primary-color);
}
.model-card-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
}
.model-card-icon { color: var(--primary-color); font-size: 0.9rem; }
.model-card-title {
  font-family: var(--font-numeric);
  font-size: 1rem;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.model-card-check { margin-left: auto; color: var(--primary-color); }
.model-card-tag {
  font-size: 0.62rem;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--primary-color);
}
.model-card-id {
  font-size: 0.72rem;
  color: var(--text-muted);
}
.model-card-desc {
  margin-top: 0.15rem;
  font-size: 0.8rem;
  line-height: 1.5;
  color: var(--text-secondary);
}
.model-card-foot {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  margin-top: auto;
  padding-top: 0.6rem;
  width: 100%;
  border-top: 1px solid var(--hairline);
}

/* The custom model ID lives in its own card; disabled (and dimmed) until that card is
   chosen, so the field is visible as part of the option without inviting typing. */
.model-card-input {
  width: 100%;
  padding: 0.5rem 0.75rem;
  font: inherit;
  font-size: 0.82rem;
  color: var(--text-primary);
  background: var(--panel-bg);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
}
.model-card-input:focus {
  outline: none;
  border-color: var(--primary-color);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary-color) 18%, transparent);
}
.model-card-input:disabled {
  opacity: 0.5;
  cursor: pointer;   /* a click lands on the card and selects it */
  pointer-events: none;
}

@media (max-width: 640px) {
  .model-choice { grid-template-columns: minmax(0, 1fr); }
}

.settings-error {
  color: var(--z5-color, #ef4444);
}

.settings-error i {
  margin-right: 0.3rem;
}
</style>
