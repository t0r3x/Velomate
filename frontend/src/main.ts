import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import './assets/style.css'
import './assets/premium.css'
import { applyTheme, readCachedThemeForBoot } from '@/stores/settings.store'

// Before the first paint: the stored preference lives in the database, which is a round
// trip away, so the cached value is applied up front and reconciled once settings load.
// Without this the app visibly flashes from one palette to the other on every launch.
applyTheme(readCachedThemeForBoot())

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
