/**
 * API client — thin fetch() wrappers for every backend endpoint.
 * All calls use relative URLs so the app works on any hostname/port.
 */
import type {
  UserHRProfile,
  Recommendation,
  GeminiKeyStatus,
  DashboardResponse,
  ActivitiesRefreshResponse,
  SyncResult
} from '@/types'

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: string
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options
  })
  if (!res.ok) {
    let details: string | undefined
    try {
      const body = await res.json()
      details = body.error || body.details || JSON.stringify(body)
    } catch { /* ignore */ }
    throw new ApiError(res.status, `HTTP ${res.status}`, details)
  }
  return res.json() as Promise<T>
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export const getStatus = () =>
  request<{ loggedIn: boolean }>('/api/status')

export const postLogin = (username: string, password: string) =>
  request<{ success?: boolean; mfaRequired?: boolean }>('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username, password })
  })

export const postMfa = (code: string) =>
  request<{ success: boolean }>('/api/mfa', {
    method: 'POST',
    body: JSON.stringify({ code })
  })

export const postLogout = () =>
  request<void>('/api/logout', { method: 'POST' })

// ── Dashboard ─────────────────────────────────────────────────────────────────

export const getDashboard = () =>
  request<DashboardResponse>('/api/dashboard')

// ── Activities ────────────────────────────────────────────────────────────────

export const postActivitiesRefresh = () =>
  request<ActivitiesRefreshResponse>('/api/activities/refresh', { method: 'POST' })

// ── Profile ───────────────────────────────────────────────────────────────────

export const getProfile = () =>
  request<UserHRProfile>('/api/profile')

export const postProfile = (profile: Partial<UserHRProfile>) =>
  request<{ success: boolean }>('/api/profile', {
    method: 'POST',
    body: JSON.stringify(profile)
  })

// ── Settings ──────────────────────────────────────────────────────────────────

export const getGeminiKeyStatus = () =>
  request<GeminiKeyStatus>('/api/settings/gemini-key')

export const postGeminiKey = (apiKey: string) =>
  request<void>('/api/settings/gemini-key', {
    method: 'POST',
    body: JSON.stringify({ apiKey })
  })

export const postGeminiModel = (model: string) =>
  request<void>('/api/settings/gemini-model', {
    method: 'POST',
    body: JSON.stringify({ model })
  })

export const postPreferredDays = (days: string[]) =>
  request<void>('/api/settings/preferred-long-ride-days', {
    method: 'POST',
    body: JSON.stringify({ days })
  })

export const postSetupComplete = () =>
  request<void>('/api/settings/setup-complete', { method: 'POST' })

// ── Recommendation ────────────────────────────────────────────────────────────

export const getRecommendation = () =>
  request<Recommendation | { notConfigured: true } | { noData: true }>('/api/recommendation')

export const postRefreshRecommendation = () =>
  request<Recommendation>('/api/recommendation/refresh', { method: 'POST' })

export const postSkipToday = () =>
  request<Recommendation>('/api/recommendation/skip-today', { method: 'POST' })

export const postReschedule = (fromDate: string, toDate: string) =>
  request<Recommendation>('/api/recommendation/reschedule', {
    method: 'POST',
    body: JSON.stringify({ fromDate, toDate })
  })

// ── Sync ──────────────────────────────────────────────────────────────────────

export const postSyncWorkouts = (scheduleDate: string) =>
  request<SyncResult>('/api/sync-workouts', {
    method: 'POST',
    body: JSON.stringify({ scheduleDate })
  })
