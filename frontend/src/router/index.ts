import { createRouter, createWebHistory } from 'vue-router'
import SetupView        from '@/views/SetupView.vue'
import ProfileSetupView from '@/views/ProfileSetupView.vue'
import DashboardView    from '@/views/DashboardView.vue'
import { useAuthStore }     from '@/stores/auth.store'
import { useSettingsStore } from '@/stores/settings.store'

const routes = [
  { path: '/setup',         name: 'setup',         component: SetupView },
  { path: '/profile-setup', name: 'profile-setup', component: ProfileSetupView },
  { path: '/',              name: 'dashboard',      component: DashboardView },
  // Catch-all → dashboard (guard handles redirects)
  { path: '/:pathMatch(.*)*', redirect: '/' }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

/**
 * Navigation guard — exact translation of maybeEnterDashboard().
 * Both stores must be initialised before any routing decision is made,
 * mirroring the statusLoaded && geminiStatusLoaded gate in the vanilla version.
 */
router.beforeEach(async (to) => {
  const auth     = useAuthStore()
  const settings = useSettingsStore()

  // First navigation: initialise both stores in parallel (like the parallel fetch calls)
  if (!auth.loaded || !settings.loaded) {
    await Promise.all([auth.init(), settings.init()])
  }

  // Not ready → always show setup screen
  if (!auth.isLoggedIn || !settings.geminiConfigured) {
    if (to.name !== 'setup') return { name: 'setup' }
    return
  }

  // Logged in + AI configured, but HR profile not confirmed yet → profile setup
  // Allow navigating back to 'setup' as well (e.g. Back button in profile-setup)
  if (!settings.setupComplete) {
    if (to.name !== 'profile-setup' && to.name !== 'setup') return { name: 'profile-setup' }
    return
  }

  // Fully set up → redirect away from setup screens to dashboard
  if (to.name === 'setup' || to.name === 'profile-setup') {
    return { name: 'dashboard' }
  }
})

export default router
