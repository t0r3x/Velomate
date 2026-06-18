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
  SyncResult,
  PausedResponse
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
      details = body.details || body.error || JSON.stringify(body)
    } catch { /* ignore */ }
    console.error('[API]', options.method ?? 'GET', path, res.status, details)
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

export const deleteGeminiKey = () =>
  request<{ removed: boolean }>('/api/settings/gemini-key', { method: 'DELETE' })

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

export const getTrainingGoals = () =>
  request<{ goals: string }>('/api/settings/training-goals')

export const postTrainingGoals = (goals: string) =>
  request<{ saved: boolean }>('/api/settings/training-goals', {
    method: 'POST',
    body: JSON.stringify({ goals })
  })

// ── Recommendation ────────────────────────────────────────────────────────────

export const getRecommendation = () =>
  request<Recommendation | { notConfigured: true } | { noData: true } | PausedResponse>('/api/recommendation')

export const postRefreshRecommendation = () =>
  request<Recommendation>('/api/recommendation/refresh', { method: 'POST' })

export const postSkipToday = () =>
  request<Recommendation>('/api/recommendation/skip-today', { method: 'POST' })

export const postReschedule = (fromDate: string, toDate: string) =>
  request<Recommendation>('/api/recommendation/reschedule', {
    method: 'POST',
    body: JSON.stringify({ fromDate, toDate })
  })

// ── Training pause ────────────────────────────────────────────────────────────

export const postPauseTraining = (reason?: string) =>
  request<PausedResponse>('/api/training/pause', {
    method: 'POST',
    body: JSON.stringify({ reason: reason || '' })
  })

export const postResumeTraining = () =>
  request<{ resumed: true }>('/api/training/resume', { method: 'POST' })

// ── Sync ──────────────────────────────────────────────────────────────────────

export const postSyncWorkouts = (scheduleDate: string) =>
  request<SyncResult>('/api/sync-workouts', {
    method: 'POST',
    body: JSON.stringify({ scheduleDate })
  })
