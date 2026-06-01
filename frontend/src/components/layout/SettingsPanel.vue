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
              <i class="fa-solid" :class="loginBusy ? 'fa-spinner fa-spin' : 'fa-arrow-right-to-bracket'"></i>
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
            <i class="fa-solid fa-arrow-right-from-bracket"></i>
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
              <h3>AI Connected</h3>
              <p class="helper-text">{{ settingsStore.maskedKey }}</p>
            </div>
          </div>
        </div>

        <p class="helper-text">Enter your AI API key to enable adaptive training recommendations.</p>
        <form @submit.prevent>
          <div class="input-group">
            <label for="panel-api-key">AI API Key</label>
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
                <optgroup label="── Free Tier ──────────────────────">
                  <option value="gemini-3.5-flash">gemini-3.5-flash (Recommended / Default)</option>
                  <option value="gemini-3.1-flash-lite">gemini-3.1-flash-lite</option>
                  <option value="gemini-3-flash-preview">gemini-3-flash-preview</option>
                  <option value="gemini-2.5-flash">gemini-2.5-flash</option>
                  <option value="gemini-2.5-flash-lite">gemini-2.5-flash-lite</option>
                </optgroup>
                <optgroup label="── Paid / Preview ─────────────────">
                  <option value="gemini-3.1-pro-preview">gemini-3.1-pro-preview</option>
                  <option value="gemini-2.5-pro">gemini-2.5-pro</option>
                </optgroup>
              </select>
            </div>
            <p class="helper-text" style="margin-top:0.35rem">
              Free tier models have daily rate limits.
              <a href="https://ai.google.dev/gemini-api/docs/models" target="_blank" rel="noopener" style="color:var(--primary-color)">See all models ↗</a>
            </p>
          </div>
        </form>
      </div>

    </div><!-- /settings-panel-body -->

    <div class="settings-panel-footer">
      <button class="btn btn-primary" :disabled="saveBusy" @click="handleSave">
        <span>{{ saveBusy ? 'Saving…' : 'Save Settings' }}</span>
        <i class="fa-solid" :class="saveBusy ? 'fa-spinner fa-spin' : 'fa-floppy-disk'"></i>
      </button>
      <button class="btn btn-secondary" @click="handleEditProfile">
        <span>Training Profile</span>
        <i class="fa-solid fa-user-gear"></i>
      </button>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { useRouter }   from 'vue-router'
import { useAuthStore }     from '@/stores/auth.store'
import { useSettingsStore } from '@/stores/settings.store'
import { useToast }         from '@/composables/useToast'

const props  = defineProps<{ open: boolean }>()
const emit   = defineEmits<{ 'update:open': [boolean]; 'edit-profile': [] }>()

const authStore     = useAuthStore()
const settingsStore = useSettingsStore()
const router        = useRouter()
const { show }      = useToast()

// Auth form state
const username = ref('')
const password = ref('')
const mfaCode  = ref('')
const loginBusy = ref(false)

// AI settings form state
const apiKey        = ref('')
const selectedModel = ref('gemini-3.5-flash')
const saveBusy      = ref(false)

// Sync form state from store when panel opens
watch(() => props.open, (isOpen) => {
  if (isOpen) {
    selectedModel.value = settingsStore.geminiModel
    apiKey.value        = ''
    mfaCode.value       = ''
  }
})

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

// ── Save Settings ─────────────────────────────────────────────────────────────

async function handleSave() {
  saveBusy.value = true
  try {
    const onSetup = router.currentRoute.value.name === 'setup'
    const success = await settingsStore.saveAll(apiKey.value, selectedModel.value)
    if (!success) {
      show('error', 'Save Failed', 'Could not save settings.')
      return
    }
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

function handleEditProfile() {
  emit('update:open', false)
  emit('edit-profile')
}
</script>
