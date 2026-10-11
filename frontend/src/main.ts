import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import './assets/style.css'
import './assets/premium.css'
import { applyTheme, readCachedThemeForBoot } from '@/stores/settings.store'
import { startBoot, bootStep, loadFonts } from '@/utils/boot'

// Before the first paint: the stored preference lives in the database, which is a round
// trip away, so the cached value is applied up front and reconciled once settings load.
// Without this the app visibly flashes from one palette to the other on every launch.
applyTheme(readCachedThemeForBoot())

// Hide the app until fonts, icons and the first view are ready, so it appears in one go
// instead of painting in visible stages. See utils/boot.ts.
startBoot()
loadFonts().then(() => bootStep('fonts'))

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')

// The dashboard reports 'view' itself, after its first data load; every other route
// (setup, profile setup) has nothing to wait for once the router has resolved.
router.isReady().then(() => {
  if (router.currentRoute.value.path !== '/') bootStep('view')
})
