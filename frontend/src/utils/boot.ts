/**
 * First-paint gate: the app is hidden (html.app-booting) until it can appear in its final
 * shape, then shown in one go.
 *
 * Without it every launch and refresh painted in stages, recorded frame by frame: a fallback
 * font with no icons, then the web fonts and Font Awesome swapping in (text and headers
 * reflowing), and the training card's "Updating…" placeholder before the plan arrived.
 *
 * Two steps must finish: 'fonts' (main.ts) and 'view' (DashboardView after its first data
 * load, or main.ts for every other route). A hard timeout reveals the app regardless, so a
 * slow backend or no internet (the fonts come from Google and a CDN) never leaves the
 * window blank; the worst case is the old staged paint.
 */
const BOOT_TIMEOUT_MS = 1500

const pending = new Set<string>(['fonts', 'view'])
let revealed = false

function reveal(): void {
  if (revealed) return
  revealed = true
  document.documentElement.classList.remove('app-booting')
}

export function startBoot(): void {
  document.documentElement.classList.add('app-booting')
  setTimeout(reveal, BOOT_TIMEOUT_MS)
}

export function bootStep(name: 'fonts' | 'view'): void {
  pending.delete(name)
  if (pending.size === 0) reveal()
}

/**
 * Start loading every face the first screen uses, instead of waiting for the browser to
 * discover them while laying out (which is what made them swap in after the first paint).
 */
export function loadFonts(): Promise<unknown> {
  if (!document.fonts?.load) return Promise.resolve()
  return Promise.all([
    document.fonts.load('400 1em Inter'),
    document.fonts.load('600 1em Inter'),
    document.fonts.load('600 1em "Inter Tight"'),
    document.fonts.load('400 1em "Inter Tight"'),
    document.fonts.load('900 1em "Font Awesome 6 Free"'),
    document.fonts.load('400 1em "Font Awesome 6 Free"'),
  ]).catch(() => undefined)
}
