// API Client for Unbound Dashboard
// Empty string → all fetch() calls use relative URLs, so the app works regardless
// of whether it's accessed via localhost, a Pi IP, or any other hostname.
const API_BASE_URL = '';

// State variables
let isLoggedIn            = false;
let geminiConfigured      = false;
let setupComplete         = false;   // persisted in DB settings table, not localStorage
let statusLoaded          = false;   // true once checkStatus() has returned at least once
let geminiStatusLoaded    = false;   // true once fetchGeminiKeyStatus() has returned
let currentProfile        = null;
let currentRecommendation = null;
let psModalMode           = false;   // true when HR profile opened as overlay over dashboard

// DOM Elements
const statusDot        = document.getElementById('status-dot');
const statusText       = document.getElementById('status-text');
const btnOpenPanel     = document.getElementById('btn-open-panel');
const btnClosePanel    = document.getElementById('btn-close-panel');
const settingsPanel    = document.getElementById('settings-panel');
const panelOverlay     = document.getElementById('panel-overlay');
const garminBtnHrLabel = document.getElementById('garmin-btn-hr-label');

const loggedOutSection = document.getElementById('auth-status-logged-out');
const loggedInSection  = document.getElementById('auth-status-logged-in');
const loginForm        = document.getElementById('login-form');
const usernameInput    = document.getElementById('username');
const passwordInput    = document.getElementById('password');
const mfaSection       = document.getElementById('mfa-section');
const mfaInput         = document.getElementById('mfa-code');
const btnLogin         = document.getElementById('btn-login');
const btnLogout        = document.getElementById('btn-logout');

const btnSync            = document.getElementById('btn-sync-workouts');
const syncResult         = document.getElementById('sync-result');
const syncedWorkoutsList = document.getElementById('synced-workouts-list');

// Gemini / AI Recommendation DOM refs
const geminiKeyForm       = document.getElementById('gemini-key-form');
const geminiApiKeyInput   = document.getElementById('gemini-api-key');
const geminiKeyStatus     = document.getElementById('gemini-key-status');
const geminiKeyMasked     = document.getElementById('gemini-key-masked');
const btnSaveAll          = document.getElementById('btn-save-all');
const btnRefreshRec       = document.getElementById('btn-refresh-rec');
const btnSkipToday        = document.getElementById('btn-skip-today');
const btnRetryRec         = document.getElementById('btn-retry-rec');
const btnOpenPanelFromRec = document.getElementById('btn-open-panel-from-rec');
const aiWeekGrid          = document.getElementById('ai-week-grid');
const aiWeekLabel         = document.getElementById('ai-week-label');
const aiTodayType         = document.getElementById('ai-today-type');
const aiTodayIcon         = document.getElementById('ai-today-icon');
const aiTodayChip         = document.getElementById('ai-today-chip');
const aiTodayReason       = document.getElementById('ai-today-reason');
const aiPriorityBadge     = document.getElementById('ai-priority-badge');
const aiLoadFatigue       = document.getElementById('ai-load-fatigue');
const aiLoadTrend         = document.getElementById('ai-load-trend');
const aiLoadInsight       = document.getElementById('ai-load-insight');
const aiGeneratedAt       = document.getElementById('ai-generated-at');
const aiNextWeekSummary   = document.getElementById('ai-next-week-summary');
const aiNextWeekChips     = document.getElementById('ai-next-week-chips');
const aiNextWeekEmphasis  = document.getElementById('ai-next-week-emphasis');

const preferredDaysGrid     = document.getElementById('preferred-days-grid');
const geminiModelSelect     = document.getElementById('gemini-model');
const btnAnalyze        = document.getElementById('btn-analyze');
const activitiesList    = document.getElementById('activities-list');
const authLoading       = document.getElementById('auth-status-loading');

// ── Helpers ────────────────────────────────────────────────────────────────────

// Clone a <template> by id and return its root element
const cloneTemplate = (id) =>
  document.getElementById(id).content.cloneNode(true).firstElementChild;

// Update a button's label and icon from a named state (data-* attributes on the element)
const setBtn = (btn, state) => {
  const label = btn.dataset[`${state}Label`];
  const icon  = btn.dataset[`${state}Icon`];
  if (label !== undefined) btn.querySelector('span').textContent = label;
  if (icon  !== undefined) btn.querySelector('i').className = `fa-solid ${icon}`;
};

// ── Views ──────────────────────────────────────────────────────────────────────
const viewSetup         = document.getElementById('view-setup');
const viewProfileSetup  = document.getElementById('view-profile-setup');
const viewDashboard     = document.getElementById('view-dashboard');

let currentView = null;   // set by setView(); null until first async init completes

const setView = (name) => {
  currentView = name;
  viewSetup.classList.toggle('hidden',        name !== 'setup');
  viewProfileSetup.classList.toggle('hidden', name !== 'profile-setup');
  viewDashboard.classList.toggle('hidden',    name !== 'dashboard');
};

/** Update the visual status of each step on the setup screen. */
const updateSetupSteps = () => {
  const garminStep   = document.getElementById('setup-step-garmin');
  const geminiStep   = document.getElementById('setup-step-gemini');
  const garminStatus = document.getElementById('setup-step-garmin-status');
  const geminiStatus = document.getElementById('setup-step-gemini-status');

  garminStep.classList.toggle('step-done', isLoggedIn);
  garminStatus.textContent = isLoggedIn ? '✓ Connected' : '–';

  geminiStep.classList.toggle('step-done', geminiConfigured);
  geminiStatus.textContent = geminiConfigured ? '✓ Configured' : '–';
};

/** Calculate HR zones from LTHR and max HR (mirrors backend calculateDefaultZones). */
const calcZones = (lthr, maxHr) => ({
  z1: { min: 0,                            max: Math.round(lthr * 0.65) },
  z2: { min: Math.round(lthr * 0.65) + 1, max: Math.round(lthr * 0.80) },
  z3: { min: Math.round(lthr * 0.80) + 1, max: Math.round(lthr * 0.89) },
  z4: { min: Math.round(lthr * 0.89) + 1, max: lthr },
  z5: { min: lthr + 1,                     max: maxHr }
});

/** Refresh the zone visualiser inside the profile-setup view. */
const updatePsZonesBar = (maxHr, lthr) => {
  const bar = document.getElementById('ps-zones-bar');
  if (!bar) return;
  const z = calcZones(lthr, maxHr);

  const zones = [
    { key: 'z1', min: z.z1.min, max: z.z1.max, width: Math.max(1, Math.round(z.z1.max / maxHr * 100)) },
    { key: 'z2', min: z.z2.min, max: z.z2.max, width: Math.max(1, Math.round((z.z2.max - z.z2.min) / maxHr * 100)) },
    { key: 'z3', min: z.z3.min, max: z.z3.max, width: Math.max(1, Math.round((z.z3.max - z.z3.min) / maxHr * 100)) },
    { key: 'z4', min: z.z4.min, max: z.z4.max, width: Math.max(1, Math.round((z.z4.max - z.z4.min) / maxHr * 100)) },
    { key: 'z5', min: z.z5.min, max: z.z5.max, width: Math.max(1, Math.round((maxHr - lthr) / maxHr * 100)) },
  ];

  zones.forEach(({ key, min, max, width }) => {
    const seg = bar.querySelector(`.${key}`);
    if (!seg) return;
    seg.style.width = `${width}%`;
    seg.querySelector('.zbs-range').textContent = `${min}–${max}`;
    seg.title = `${key.toUpperCase()}: ${min}–${max} bpm`;
  });
};

/** Close the profile-setup modal (only used when psModalMode is true). */
const closePsModal = () => {
  psModalMode = false;
  viewProfileSetup.classList.add('hidden');
  viewProfileSetup.classList.remove('ps-modal');
};

/** Auto-fetch Garmin data and show the HR profile setup form (Step 2).
 *  Pass fromDashboard=true to show it as a modal overlay over the dashboard. */
const enterProfileSetup = async (fromDashboard = false) => {
  psModalMode = fromDashboard;
  if (fromDashboard) {
    viewProfileSetup.classList.remove('hidden');
    viewProfileSetup.classList.add('ps-modal');
    closePanel();
  } else {
    setView('profile-setup');
    closePanel();
  }

  const loadingEl         = document.getElementById('ps-loading');
  const formEl            = document.getElementById('ps-form');
  const noticeEl          = document.getElementById('ps-notice');
  const suggestionRow     = document.getElementById('ps-suggestion-row');
  const suggestionLoading = document.getElementById('ps-suggestion-loading');
  const sugMaxHrEl        = document.getElementById('ps-sug-maxhr');
  const sugLthrEl         = document.getElementById('ps-sug-lthr');
  const sugRidesEl        = document.getElementById('ps-suggestion-rides');

  const hasCustom  = currentProfile?.hasCustomOverrides;
  const inputMaxHr = currentProfile?.maxHr || 190;
  const inputLthr  = currentProfile?.lthr  || 165;

  // Populate inputs immediately — no waiting for the Garmin fetch
  document.getElementById('ps-max-hr').value = inputMaxHr;
  document.getElementById('ps-lthr').value   = inputLthr;
  updatePsZonesBar(inputMaxHr, inputLthr);

  // Suggestion area always starts in loading state (spinner reserves the space)
  suggestionLoading.classList.remove('hidden');
  suggestionRow.classList.add('hidden');
  noticeEl.classList.add('hidden');

  // Show form straight away; full-screen loader only for first-time users who need
  // the suggestion in order to have meaningful default values in the inputs.
  if (hasCustom) {
    loadingEl.classList.add('hidden');
    formEl.classList.remove('hidden');
  } else {
    loadingEl.classList.remove('hidden');
    formEl.classList.add('hidden');
  }

  try {
    const res  = await fetch(`${API_BASE_URL}/api/activities/refresh`, { method: 'POST' });
    const data = await res.json();

    if (res.ok && data.analysis?.estimatedMaxHr) {
      const sugMaxHr = data.analysis.estimatedMaxHr;
      const sugLthr  = data.analysis.estimatedLthr || inputLthr;
      const sugRides = data.analysis.totalCyclingRides || 0;
      if (data.currentProfile) currentProfile = data.currentProfile;

      suggestionLoading.classList.add('hidden');

      if (hasCustom) {
        // Show suggestion row only when it differs from the user's saved values
        if (sugMaxHr !== inputMaxHr || sugLthr !== inputLthr) {
          sugMaxHrEl.textContent         = sugMaxHr;
          sugLthrEl.textContent          = sugLthr;
          sugRidesEl.textContent         = `${sugRides} ride${sugRides !== 1 ? 's' : ''}`;
          suggestionRow.dataset.sugMaxHr = sugMaxHr;
          suggestionRow.dataset.sugLthr  = sugLthr;
          suggestionRow.classList.remove('hidden');
        }
        // Values identical → both spinner and row hidden; area collapses cleanly
      } else {
        // First-time: fill inputs with suggestion, then reveal form
        document.getElementById('ps-max-hr').value = sugMaxHr;
        document.getElementById('ps-lthr').value   = sugLthr;
        updatePsZonesBar(sugMaxHr, sugLthr);
        sugMaxHrEl.textContent         = sugMaxHr;
        sugLthrEl.textContent          = sugLthr;
        sugRidesEl.textContent         = `${sugRides} ride${sugRides !== 1 ? 's' : ''}`;
        suggestionRow.dataset.sugMaxHr = sugMaxHr;
        suggestionRow.dataset.sugLthr  = sugLthr;
        suggestionRow.classList.remove('hidden');
      }
    } else {
      // No Garmin data — hide spinner, show a brief notice only if no custom values
      suggestionLoading.classList.add('hidden');
      if (!hasCustom) {
        noticeEl.textContent = 'No Garmin rides yet — using defaults. Adjust to match your fitness level.';
        noticeEl.className   = 'ps-notice ps-notice-info';
        noticeEl.classList.remove('hidden');
      }
    }
  } catch {
    suggestionLoading.classList.add('hidden');
    if (!hasCustom) {
      noticeEl.textContent = 'Garmin data unavailable — using defaults. You can update at any time.';
      noticeEl.className   = 'ps-notice ps-notice-info';
      noticeEl.classList.remove('hidden');
    }
  }

  loadingEl.classList.add('hidden');
  formEl.classList.remove('hidden');
};

/** Transition from setup screen when both Garmin and Gemini are ready.
 *  Routes to the HR Profile setup (Step 2) for new users, or directly
 *  to the dashboard for returning users. Never interrupts later views. */
const maybeEnterDashboard = () => {
  // Wait until BOTH init calls have returned before making any routing decision.
  // Either call alone cannot determine the full state:
  //   - checkStatus alone: knows isLoggedIn but not geminiConfigured
  //   - fetchGeminiKeyStatus alone: knows geminiConfigured but not isLoggedIn
  // Without this guard one of the two resolving first would briefly flash the wrong view.
  if (!statusLoaded || !geminiStatusLoaded) return;

  updateSetupSteps();
  if (!isLoggedIn || !geminiConfigured) {
    // Not ready yet — if nothing is visible yet (blank page), show the setup screen.
    if (currentView === null) setView('setup');
    return;
  }

  // Only act when on (or waiting to show) the initial setup screen.
  // null = page just loaded, no view shown yet — treat as 'setup'.
  if (currentView !== 'setup' && currentView !== null) return;

  // Only skip Step 2 when the user has explicitly confirmed their HR profile.
  // setupComplete is loaded from the DB on init via fetchGeminiKeyStatus().
  if (setupComplete) {
    setView('dashboard');
    closePanel();
  } else {
    // New user OR returning user who hasn't confirmed Step 2 yet
    enterProfileSetup();
  }
};

// ── Side Panel ─────────────────────────────────────────────────────────────────
const openPanel = () => {
  settingsPanel.classList.add('open');
  panelOverlay.classList.add('open');
  document.body.style.overflow = 'hidden';
};
const closePanel = () => {
  settingsPanel.classList.remove('open');
  panelOverlay.classList.remove('open');
  document.body.style.overflow = '';
};
btnOpenPanel.addEventListener('click', openPanel);
btnClosePanel.addEventListener('click', closePanel);
panelOverlay.addEventListener('click', closePanel);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closePanel(); });
document.getElementById('btn-open-setup').addEventListener('click', openPanel);

// ── Toast ──────────────────────────────────────────────────────────────────────
const toast = (type, title, msg = '', duration = 4000) => {
  const icons = {
    success: 'fa-circle-check',
    error:   'fa-circle-xmark',
    info:    'fa-circle-info',
    warn:    'fa-triangle-exclamation'
  };
  const el = cloneTemplate('tpl-toast');
  el.classList.add(type);
  el.querySelector('.toast-icon').classList.add(icons[type] || icons.info);
  el.querySelector('.toast-title').textContent = title;
  const msgEl = el.querySelector('.toast-msg');
  if (msg) {
    msgEl.textContent = msg;
  } else {
    msgEl.remove();
  }
  el.querySelector('.toast-close').addEventListener('click', () => el.remove());
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => {
    el.classList.add('removing');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, duration);
};

// ── Week/Workout helpers ───────────────────────────────────────────────────────
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const zoneColors = {
  z1: 'var(--z1-color, #6ec6e6)',
  z2: 'var(--z2-color, #6ee68a)',
  z3: 'var(--z3-color, #e6d46e)',
  z4: 'var(--z4-color, #e6a06e)',
  z5: 'var(--z5-color, #e66e6e)'
};

const workoutTypeIcon  = { Sprint: 'fa-bolt', Threshold: 'fa-fire-flame-curved', LongRide: 'fa-road', Rest: 'fa-bed' };
const workoutTypeLabel = { Sprint: 'Sprint',  Threshold: 'Threshold',            LongRide: 'Long Ride', Rest: 'Rest' };

// ── AI Recommendation ──────────────────────────────────────────────────────────

/** Show/hide the correct state panel inside the AI card. */
const setRecState = (state) => {
  const states = ['not-configured', 'no-plan', 'loading', 'loaded', 'error'];
  states.forEach(s => {
    const el = document.getElementById(`rec-state-${s}`);
    if (el) el.classList.toggle('hidden', s !== state);
  });
  // Sync button requires an active plan — disable for every non-loaded state.
  // renderRecommendation() re-enables it when planned workouts are present.
  if (state !== 'loaded') btnSync.disabled = true;
};

/** Populate all AI card UI elements from a recommendation object. */
const renderRecommendation = (rec) => {
  currentRecommendation = rec;

  // Today chip
  const type = rec.workoutType || 'Rest';
  const icon = workoutTypeIcon[type]  || 'fa-dumbbell';
  const label = workoutTypeLabel[type] || type;

  // Clear previous type classes from chip
  aiTodayChip.className = `ai-workout-chip wt-${type.toLowerCase()}`;
  aiTodayIcon.className = `fa-solid ${icon}`;
  aiTodayType.textContent = label;

  // Priority badge — map raw AI value to user-friendly label
  const priority = rec.priority || '';
  const priorityLabels = { high: 'Essential', medium: 'Recommended', low: 'Optional' };
  aiPriorityBadge.className = `ai-priority-badge priority-${priority.toLowerCase()}`;
  aiPriorityBadge.textContent = priorityLabels[priority.toLowerCase()] || priority;

  // Today reason
  aiTodayReason.textContent = rec.reason || '';

  // Week grid
  const plan = Array.isArray(rec.weeklyPlan) ? rec.weeklyPlan : [];
  aiWeekGrid.innerHTML = '';
  // Durations come from AI-generated structures (entry.structure.totalMinutes)

  if (plan.length > 0) {
    // Week label: first date to last date
    const fmt = d => new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    aiWeekLabel.textContent = `${fmt(plan[0].date)} – ${fmt(plan[plan.length - 1].date)}`;

    const todayStr = new Date().toLocaleDateString('sv-SE');
    plan.forEach(entry => {
      const isToday = entry.date === todayStr;
      const isRest  = entry.type === 'Rest';

      let cell;
      if (isRest) {
        cell = cloneTemplate('tpl-week-day-rest');
      } else {
        cell = cloneTemplate('tpl-week-day-workout');
        cell.classList.add('has-workout', `wt-${entry.type.toLowerCase()}`);
        cell.querySelector('.wdc-workout-chip i').classList.add(workoutTypeIcon[entry.type] || 'fa-dumbbell');
        cell.querySelector('.wdc-workout-label').textContent = workoutTypeLabel[entry.type] || entry.type;
        cell.querySelector('.wdc-duration').textContent = entry.structure?.totalMinutes
          ? `${entry.structure.totalMinutes} min`
          : '';
        // Status badge — repurpose wdc-scheduled-badge based on completion state
        const badge = cell.querySelector('.wdc-scheduled-badge');
        const STATUS_BADGE = {
          'completed':          { icon: 'fa-circle-check',      label: 'Done',     cls: 'wdc-badge-done'     },
          'completed-partial':  { icon: 'fa-circle-half-stroke', label: 'Partial',  cls: 'wdc-badge-partial'  },
          'completed-mismatch': { icon: 'fa-circle-exclamation', label: 'Mismatch', cls: 'wdc-badge-mismatch' },
          'skipped':            { icon: 'fa-forward-step',       label: 'Skipped',  cls: 'wdc-badge-skipped'  },
          'auto-skipped':       { icon: 'fa-forward-step',       label: 'Skipped',  cls: 'wdc-badge-skipped'  },
        };
        const badgeDef = STATUS_BADGE[entry.status];
        if (badge && badgeDef) {
          badge.innerHTML = `<i class="fa-solid ${badgeDef.icon}"></i> ${badgeDef.label}`;
          badge.className = `wdc-scheduled-badge ${badgeDef.cls}`;
          badge.hidden = false;
        } else if (badge) {
          badge.hidden = true;
        }

        // Show a small tooltip via title
        cell.title = entry.reason || '';
      }

      const d = new Date(entry.date + 'T12:00:00');
      cell.querySelector('.wdc-day-label').textContent = DAY_NAMES[d.getDay()];
      cell.querySelector('.wdc-date').textContent      = d.getDate();

      if (isToday)                              cell.classList.add('is-today');
      if (entry.status === 'completed')         cell.classList.add('is-completed');
      if (entry.status === 'completed-partial') cell.classList.add('is-completed-partial');
      if (entry.status === 'completed-mismatch')cell.classList.add('is-mismatch');
      if (entry.status === 'skipped' || entry.status === 'auto-skipped')
                                                cell.classList.add('is-skipped');

      // "Move to today" button — only on future planned workouts (not rest, not today, not past)
      if (!isRest && !isToday && entry.status === 'planned' && entry.date > todayStr) {
        const moveBtn = document.createElement('button');
        moveBtn.className = 'btn-move-today';
        moveBtn.title     = 'Move to today';
        moveBtn.innerHTML = '<i class="fa-solid fa-calendar-day"></i>';
        moveBtn.addEventListener('click', e => {
          e.stopPropagation();
          rescheduleToToday(entry.date);
        });
        cell.appendChild(moveBtn);
      }

      aiWeekGrid.appendChild(cell);
    });
  }

  // Next week overview
  const nwo = rec.nextWeekOverview;
  if (nwo) {
    aiNextWeekSummary.textContent  = nwo.summary  || '';
    aiNextWeekEmphasis.textContent = nwo.emphasis || '';

    aiNextWeekChips.innerHTML = '';
    (nwo.sessions || []).forEach(s => {
      const chip = cloneTemplate('tpl-next-week-chip');
      const chipIcon = workoutTypeIcon[s.type] || 'fa-dumbbell';
      chip.classList.add(`wt-${s.type.toLowerCase()}`);
      chip.querySelector('i').classList.add(chipIcon);
      chip.querySelector('.nw-type').textContent = workoutTypeLabel[s.type] || s.type;
      chip.querySelector('.nw-day').textContent  = s.estimatedDay || '';
      aiNextWeekChips.appendChild(chip);
    });
  }

  // Load assessment
  const la = rec.loadAssessment;
  if (la) {
    aiLoadFatigue.textContent  = la.fatigue
      ? la.fatigue.charAt(0).toUpperCase() + la.fatigue.slice(1) + ' fatigue'
      : '';
    aiLoadFatigue.className    = `ai-load-fatigue-badge fatigue-${(la.fatigue || 'low').toLowerCase()}`;
    aiLoadTrend.textContent    = la.weeklyLoadTrend
      ? `Load: ${la.weeklyLoadTrend}`
      : '';
    aiLoadInsight.textContent  = la.insight || '';
  }

  // Generated at timestamp
  if (rec.generatedAt) {
    aiGeneratedAt.textContent = `Updated ${timeAgo(rec.generatedAt)}`;
  }

  // Enable Sync button only when there are planned syncable workouts and Garmin is connected
  const hasSyncableWorkout = plan.some(e => e.status === 'planned');
  btnSync.disabled = !(isLoggedIn && hasSyncableWorkout);

};


/** Fetch Gemini key status + setupComplete flag from backend, update panel UI and gate state. */
const fetchGeminiKeyStatus = async () => {
  try {
    const res  = await fetch(`${API_BASE_URL}/api/settings/gemini-key`);
    const data = await res.json();
    geminiConfigured   = !!data.hasKey;
    setupComplete      = !!data.setupComplete;
    geminiStatusLoaded = true;   // unblock maybeEnterDashboard now that we know the Gemini state
    if (data.hasKey) {
      geminiKeyStatus.classList.remove('hidden');
      geminiKeyMasked.textContent = data.maskedKey;
    } else {
      geminiKeyStatus.classList.add('hidden');
    }
    // Populate preferred long ride day checkboxes
    const preferredDays = Array.isArray(data.preferredLongRideDays) ? data.preferredLongRideDays : [];
    document.querySelectorAll('.preferred-day-cb').forEach(cb => {
      cb.checked = preferredDays.includes(cb.value);
    });
    // Set model selector
    if (geminiModelSelect && data.geminiModel) {
      geminiModelSelect.value = data.geminiModel;
    }
    updateSetupSteps();
    maybeEnterDashboard();   // fire gate now that both flags are known
  } catch {
    // Fetch failed (backend offline?) — unblock routing so the page doesn't stay blank
    geminiStatusLoaded = true;
    maybeEnterDashboard();
  }
};

/** Fetch recommendation from backend. forceRefresh=true triggers a Gemini API call. */
const fetchRecommendation = async (forceRefresh = false) => {
  setRecState('loading');
  try {
    let data;
    if (forceRefresh) {
      const res = await fetch(`${API_BASE_URL}/api/recommendation/refresh`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json();
        document.getElementById('rec-error-msg').textContent =
          err.details || err.error || 'Failed to get recommendation.';
        setRecState('error');
        return;
      }
      data = await res.json();
    } else {
      const res = await fetch(`${API_BASE_URL}/api/recommendation`);
      data = await res.json();
      if (data.notConfigured) { setRecState('not-configured'); return; }
      if (data.noData)        { setRecState('no-plan'); return; }        // key is set but no plan yet
      // stale: show existing plan as-is; backend hourly check will regenerate
    }
    renderRecommendation(data);
    setRecState('loaded');
  } catch (err) {
    document.getElementById('rec-error-msg').textContent = 'Failed to connect to backend.';
    setRecState('error');
  }
};

/** Move a future planned workout to today by swapping it with today's plan entry. */
const rescheduleToToday = async (fromDate) => {
  const toDate = new Date().toLocaleDateString('sv-SE');
  if (fromDate === toDate) return;

  try {
    const res = await fetch(`${API_BASE_URL}/api/recommendation/reschedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromDate, toDate })
    });
    const data = await res.json();
    if (!res.ok) {
      toast('error', 'Reschedule Failed', data.error || 'Could not move workout.');
      return;
    }
    renderRecommendation(data);
    setRecState('loaded');
    toast('success', 'Workout moved to today', 'Plan updated — AI recalculated the week.');
  } catch {
    toast('error', 'Connection Error', 'Could not reach backend.');
  }
};

/** Skip today's workout and regenerate the plan. */
const skipToday = async () => {
  btnSkipToday.disabled = true;
  const origIcon = btnSkipToday.querySelector('i').className;
  btnSkipToday.querySelector('i').className = 'fa-solid fa-spinner fa-spin';

  try {
    const res  = await fetch(`${API_BASE_URL}/api/recommendation/skip-today`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      toast('error', 'Skip Failed', data.error || 'Could not skip today.');
      return;
    }
    renderRecommendation(data);
    setRecState('loaded');
    toast('success', 'Workout skipped', 'Plan updated by AI.');
  } catch {
    toast('error', 'Skip Failed', 'Could not reach backend.');
  } finally {
    btnSkipToday.disabled = false;
    btnSkipToday.querySelector('i').className = origIcon;
  }
};

// ── Auth ───────────────────────────────────────────────────────────────────────

// Check connection and session status on the backend
const checkStatus = async () => {
  try {
    const response = await fetch(`${API_BASE_URL}/api/status`);
    const data = await response.json();
    isLoggedIn = data.loggedIn;
    statusLoaded = true;
    updateAuthUI(data.loggedIn);
  } catch (error) {
    console.error('Failed to connect to backend service:', error);
    statusDot.className      = 'status-dot disconnected';
    statusText.textContent   = 'Server Offline';
    btnSync.disabled         = true;
    btnAnalyze.disabled      = true;
  }
};

// Update Authentication UI elements
const updateAuthUI = (loggedIn) => {
  authLoading.classList.add('hidden');

  if (loggedIn) {
    statusDot.className = 'status-dot connected';
    statusText.textContent = 'Connected';
    loggedOutSection.classList.add('hidden');
    loggedInSection.classList.remove('hidden');
    // btnSync is NOT enabled here — renderRecommendation() enables it only when
    // a plan with at least one planned workout exists.
    btnAnalyze.disabled = false;
    setBtn(btnAnalyze, 'connected');
    maybeEnterDashboard();
  } else {
    statusDot.className = 'status-dot disconnected';
    statusText.textContent = 'Not connected';
    loggedOutSection.classList.remove('hidden');
    loggedInSection.classList.add('hidden');
    btnSync.disabled    = true;
    btnAnalyze.disabled = true;
    garminBtnHrLabel.textContent = '';
    maybeEnterDashboard();   // gated — waits for both statusLoaded + geminiStatusLoaded
  }
};

// Update the HR label in the header button
const updateHeaderHrLabel = (profile) => {
  if (profile && profile.maxHr && profile.lthr) {
    garminBtnHrLabel.textContent = `${profile.lthr} / ${profile.maxHr}`;
  }
};

// Handle Garmin login request
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const mfaCode = mfaInput.value.trim();

  // MFA step: section is visible and code is filled in
  if (!mfaSection.classList.contains('hidden') && mfaCode) {
    btnLogin.disabled = true;
    setBtn(btnLogin, 'verifying');
    try {
      const response = await fetch(`${API_BASE_URL}/api/mfa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: mfaCode })
      });
      const data = await response.json();
      if (response.ok) {
        isLoggedIn = true;
        updateAuthUI(true);
        mfaSection.classList.add('hidden');
        mfaInput.value = '';
      } else {
        toast('error', 'MFA Failed', data.error || 'Invalid code. Try again.');
      }
    } catch (error) {
      toast('error', 'Connection Error', 'Failed to contact backend MFA endpoint.');
    } finally {
      btnLogin.disabled = false;
      setBtn(btnLogin, 'idle');
    }
    return;
  }

  // Initial login step
  btnLogin.disabled = true;
  setBtn(btnLogin, 'loading');

  try {
    const response = await fetch(`${API_BASE_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: usernameInput.value, password: passwordInput.value })
    });

    const data = await response.json();

    if (response.ok) {
      if (data.mfaRequired) {
        mfaSection.classList.remove('hidden');
        mfaInput.focus();
        toast('info', 'MFA Required', 'Enter the 6-digit code sent to your email or phone.');
      } else {
        isLoggedIn = true;
        updateAuthUI(true);
        passwordInput.value = '';
      }
    } else {
      toast('error', 'Login Failed', data.error || 'Check your credentials and try again.');
    }
  } catch (error) {
    toast('error', 'Connection Error', 'Failed to contact backend login endpoint.');
  } finally {
    btnLogin.disabled = false;
    setBtn(btnLogin, 'idle');
  }
});

// Logout — invalidate backend auth cache, then update UI
btnLogout.addEventListener('click', async () => {
  isLoggedIn = false;
  updateAuthUI(false);
  try {
    await fetch(`${API_BASE_URL}/api/logout`, { method: 'POST' });
  } catch {
    // Non-critical — UI is already updated
  }
});

// ── HR Profile ─────────────────────────────────────────────────────────────────

// Fetch Profile HR Zones from API
const fetchProfile = async () => {
  try {
    const response = await fetch(`${API_BASE_URL}/api/profile`);
    const data = await response.json();
    currentProfile = data;
    populateProfileUI(data);
    updateHeaderHrLabel(data);
  } catch (error) {
    console.error('Error fetching profile:', error);
  }
};

// Update state + header label when profile changes
const populateProfileUI = (profile) => {
  currentProfile = profile;
  updateHeaderHrLabel(profile);
};

// Prevent Enter-key submission on the Gemini key form
geminiKeyForm.addEventListener('submit', e => e.preventDefault());


// ── Assessment ─────────────────────────────────────────────────────────────────

const timeAgo = (isoStr) => {
  if (!isoStr) return '';
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
};

const updateLastSynced = (analysis) => {
  const el = document.getElementById('last-synced-label');
  if (!el) return;
  el.textContent = analysis?.updatedAt ? `Last synced ${timeAgo(analysis.updatedAt)}` : '';
};

// Load all persisted data from DB — no Garmin connection required
const loadDashboard = async () => {
  try {
    const res = await fetch(`${API_BASE_URL}/api/dashboard`);
    if (!res.ok) return;
    const data = await res.json();

    if (data.profile) {
      currentProfile = data.profile;
      populateProfileUI(data.profile);
      updateHeaderHrLabel(data.profile);
    }

    renderActivities(data.activities || []);
    updateLastSynced(data.analysis);
  } catch (e) {
    console.error('Dashboard load failed:', e);
  }
};

// Sync from Garmin: fetch new rides, merge into DB, re-render
btnAnalyze.addEventListener('click', async () => {
  btnAnalyze.disabled = true;
  setBtn(btnAnalyze, 'loading');

  try {
    const response = await fetch(`${API_BASE_URL}/api/activities/refresh`, { method: 'POST' });
    const data = await response.json();

    if (!response.ok) {
      toast('error', 'Sync Failed', data.error || 'Check the server logs.');
      return;
    }

    currentProfile = data.currentProfile || currentProfile;
    renderActivities(data.activities || []);
    updateLastSynced(data.analysis);

    const n = data.newCount || 0;
    toast('success', 'Synced from Garmin',
      `${n} new ${n === 1 ? 'ride' : 'rides'} added — ${data.activities?.length || 0} total stored.`);

    // Reload the AI card — backend may have classified workouts as completed
    // after comparing plan entries against the newly-synced activities.
    fetchRecommendation(false);
  } catch (error) {
    toast('error', 'Refresh Failed', 'Could not reach the backend.');
  } finally {
    btnAnalyze.disabled = !isLoggedIn;
    setBtn(btnAnalyze, 'connected');
  }
});

// Render recent rides list
const renderActivities = (activities) => {
  activitiesList.innerHTML = '';

  if (!activities || activities.length === 0) {
    const p = document.createElement('p');
    p.className   = 'helper-text empty-state-text';
    p.textContent = 'No rides yet. Click "Refresh from Garmin" to sync your rides.';
    activitiesList.appendChild(p);
    return;
  }

  const tpl = document.getElementById('tpl-activity-item');
  activities.forEach(act => {
    const li = tpl.content.cloneNode(true).firstElementChild;

    const dateFormatted = new Date(act.startTime).toLocaleDateString('en-GB', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });

    li.querySelector('.activity-title').textContent = act.name || 'Cycling Activity';
    const ACTIVITY_TYPE_LABELS = {
      cycling:                   'Cycling',
      road_biking:               'Road Cycling',
      mountain_biking:           'Mountain Biking',
      gravel_cycling:            'Gravel Cycling',
      indoor_cycling:            'Indoor Cycling',
      virtual_ride:              'Virtual Ride',
      e_bike_mountain:           'E-Bike MTB',
      e_bike_fitness:            'E-Bike',
      bmx:                       'BMX',
      cyclocross:                'Cyclocross',
      track_cycling:             'Track Cycling',
    };
    const typeLabel = ACTIVITY_TYPE_LABELS[(act.type || '').toLowerCase()] ||
      (act.type ? act.type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Cycling');
    li.querySelector('.activity-meta').textContent  = `${dateFormatted} • ${typeLabel}`;
    li.querySelector('.act-stat--dist .act-stat-val').textContent = `${act.distanceKm} km`;
    li.querySelector('.act-stat--time .act-stat-val').textContent = `${act.durationMinutes} min`;

    const hrStat = li.querySelector('.act-stat--hr');
    if (act.averageHr > 0) {
      hrStat.querySelector('.act-stat-val').textContent = `${act.averageHr} bpm`;
    } else {
      hrStat.hidden = true;
    }

    // ── Perceived exertion + feeling badges ───────────────────────────────────
    const rpeBadge     = li.querySelector('.act-rpe-badge');
    const feelingBadge = li.querySelector('.act-feeling-badge');
    const feedbackRow  = li.querySelector('.act-feedback');

    // Garmin stores directWorkoutRpe and directWorkoutFeel on a 0–100 internal scale.
    // Convert: rpe / 10 → 1–10 Borg scale; feel / 25 + 1 → 1–5 feeling level.
    if (act.perceivedExertion != null) {
      const rpe = Math.max(1, Math.min(10, Math.round(act.perceivedExertion / 10)));
      // Color: 1-3 green, 4-5 yellow, 6-7 orange, 8-10 red
      const rpeClass = rpe <= 3 ? 'rpe-easy' : rpe <= 5 ? 'rpe-moderate' : rpe <= 7 ? 'rpe-hard' : 'rpe-max';
      rpeBadge.textContent = `RPE ${rpe}`;
      rpeBadge.classList.add(rpeClass);
      rpeBadge.classList.remove('hidden');
    }

    if (act.feelingAfterExercise != null) {
      const f = Math.max(1, Math.min(5, Math.round(act.feelingAfterExercise / 25) + 1));
      // 1=exhausted, 2=tired, 3=normal, 4=good, 5=strong
      const feelingMap = {
        1: { label: 'Exhausted', icon: 'fa-face-dizzy',        cls: 'feeling-1' },
        2: { label: 'Tired',     icon: 'fa-face-tired',        cls: 'feeling-2' },
        3: { label: 'Normal',    icon: 'fa-face-meh',          cls: 'feeling-3' },
        4: { label: 'Good',      icon: 'fa-face-smile',        cls: 'feeling-4' },
        5: { label: 'Strong',    icon: 'fa-face-grin-stars',   cls: 'feeling-5' },
      };
      const entry = feelingMap[f] || feelingMap[3];
      feelingBadge.innerHTML = `<i class="fa-regular ${entry.icon}"></i> ${entry.label}`;
      feelingBadge.classList.add(entry.cls);
      feelingBadge.classList.remove('hidden');
    }

    if (act.perceivedExertion != null || act.feelingAfterExercise != null) {
      feedbackRow.classList.remove('hidden');
    }

    activitiesList.appendChild(li);
  });
};

// ── Sync ───────────────────────────────────────────────────────────────────────

// Compile, upload, and schedule workouts on Garmin
btnSync.addEventListener('click', async () => {
  btnSync.disabled = true;
  setBtn(btnSync, 'loading');
  syncResult.classList.add('hidden');

  const plan = currentRecommendation?.weeklyPlan || [];
  const parsed = Array.isArray(plan) ? plan : [];
  const threshold = parsed.find(e => e.type === 'Threshold' && e.status === 'planned');
  const scheduleDate = threshold?.date || (() => {
    const t = new Date(); t.setDate(t.getDate() + 1);
    return t.toLocaleDateString('sv-SE');
  })();

  try {
    const response = await fetch(`${API_BASE_URL}/api/sync-workouts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scheduleDate })
    });

    const data = await response.json();

    if (response.ok) {
      const count = data.workouts?.length || 0;
      const msg   = `Uploaded and scheduled ${count} workout${count !== 1 ? 's' : ''} on Garmin. Sync your device to apply!`;
      document.getElementById('sync-result-msg').innerHTML = msg;

      syncedWorkoutsList.innerHTML = '';
      const tpl = document.getElementById('tpl-synced-workout');
      data.workouts.forEach(w => {
        const li       = tpl.content.cloneNode(true).firstElementChild;
        li.querySelector('.sw-name').textContent = w.name;
        const statusEl = li.querySelector('.sw-status');
        if (w.scheduleError) {
          statusEl.textContent = '(Upload only — schedule manually)';
          statusEl.style.color = 'var(--z3-color, #e6d46e)';
        } else if (w.scheduledDate) {
          const d    = new Date(w.scheduledDate + 'T12:00:00');
          const dFmt = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
          statusEl.textContent = `(Scheduled for ${dFmt})`;
          statusEl.style.color = 'var(--z4-color)';
        } else {
          statusEl.textContent = '(Available on Device)';
          statusEl.style.color = 'var(--text-muted)';
        }
        syncedWorkoutsList.appendChild(li);
      });

      syncResult.classList.remove('hidden');
      syncResult.scrollIntoView({ behavior: 'smooth' });

      // Warn if fallback structures were used (AI plan had no structure for some types)
      if (data.usingFallback?.length) {
        toast('warn', 'Default structures used',
          `${data.usingFallback.join(', ')} used built-in defaults — regenerate the AI plan for personalised workouts.`);
      }
      // Warn if any workout could not be scheduled on the calendar
      if (data.scheduleErrors?.length) {
        data.scheduleErrors.forEach(msg =>
          toast('warn', 'Scheduling incomplete', msg)
        );
      }
    } else {
      toast('error', 'Sync Failed', data.error || 'Check backend logs for details.');
    }
  } catch (error) {
    toast('error', 'Connection Error', 'Failed to connect to backend sync endpoint.');
  } finally {
    btnSync.disabled = false;
    setBtn(btnSync, 'idle');
  }
});

// ── Save Settings (Gemini key) ────────────────────────────────────────────────
// HR profile is configured separately in the Step-2 setup screen.

btnSaveAll.addEventListener('click', async () => {
  btnSaveAll.disabled = true;
  setBtn(btnSaveAll, 'loading');

  const newKey      = geminiApiKeyInput.value.trim();
  const onSetup     = !viewSetup.classList.contains('hidden');
  const onDashboard = !viewDashboard.classList.contains('hidden');

  try {
    // Always save preferred days + model alongside whatever else is happening
    const days  = [...document.querySelectorAll('.preferred-day-cb')]
      .filter(cb => cb.checked).map(cb => cb.value);
    const model = geminiModelSelect.value;

    await Promise.all([
      fetch(`${API_BASE_URL}/api/settings/preferred-long-ride-days`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days })
      }),
      fetch(`${API_BASE_URL}/api/settings/gemini-model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model })
      })
    ]);

    if (newKey) {
      const res = await fetch(`${API_BASE_URL}/api/settings/gemini-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: newKey })
      });
      if (res.ok) {
        geminiApiKeyInput.value = '';
        await fetchGeminiKeyStatus();
        if (onDashboard) {
          toast('success', 'Settings Saved', 'API key and preferences updated.');
          closePanel();
        } else {
          maybeEnterDashboard();
        }
      } else {
        const err = await res.json();
        toast('error', 'Save Failed', err.error || 'Could not save API key.');
      }
    } else if (onDashboard) {
      toast('success', 'Settings Saved', 'Preferences updated.');
      closePanel();
    } else if (onSetup && geminiConfigured) {
      maybeEnterDashboard();
    } else {
      toast('warn', 'AI Key Required', 'Enter your AI API key to continue.');
    }
  } catch {
    toast('error', 'Connection Error', 'Could not reach backend.');
  }

  btnSaveAll.disabled = false;
  setBtn(btnSaveAll, 'idle');
});

// ── Profile Setup (Step 2) ────────────────────────────────────────────────────

const psMaxHrInput      = document.getElementById('ps-max-hr');
const psLthrInput       = document.getElementById('ps-lthr');
const btnConfirmProfile = document.getElementById('btn-confirm-profile');

const onPsInputChange = () => {
  updatePsZonesBar(parseInt(psMaxHrInput.value) || 190, parseInt(psLthrInput.value) || 165);
};
psMaxHrInput.addEventListener('input', onPsInputChange);
psLthrInput.addEventListener('input', onPsInputChange);

document.getElementById('btn-use-suggestion').addEventListener('click', () => {
  const row  = document.getElementById('ps-suggestion-row');
  const maxHr = parseInt(row.dataset.sugMaxHr) || 190;
  const lthr  = parseInt(row.dataset.sugLthr)  || 165;
  psMaxHrInput.value = maxHr;
  psLthrInput.value  = lthr;
  updatePsZonesBar(maxHr, lthr);
  // Hide the row — suggestion is now in the inputs
  row.classList.add('hidden');
});

btnConfirmProfile.addEventListener('click', async () => {
  const maxHr  = parseInt(psMaxHrInput.value) || 190;
  const lthr   = parseInt(psLthrInput.value)  || 165;
  const zones  = calcZones(lthr, maxHr);
  const profile = { maxHr, lthr, zones, hasCustomOverrides: true };

  btnConfirmProfile.disabled = true;
  setBtn(btnConfirmProfile, 'loading');

  try {
    const res = await fetch(`${API_BASE_URL}/api/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profile)
    });
    if (res.ok) {
      currentProfile = profile;
      populateProfileUI(profile);
      updateHeaderHrLabel(profile);
      if (psModalMode) {
        // Called from dashboard settings — close the modal overlay
        closePsModal();
        toast('success', 'HR Profile Updated', 'Training zones recalculated and saved.');
      } else {
        // First-time setup flow — mark complete in DB, then proceed to dashboard.
        // Do NOT generate a plan here — the user must click "Generate my first plan"
        // so the first generation is always explicit and user-initiated.
        setupComplete = true;
        await fetch(`${API_BASE_URL}/api/settings/setup-complete`, { method: 'POST' });
        loadDashboard();
        fetchRecommendation(false);  // read-only: will show 'no-plan' state with the button
        setView('dashboard');
      }
    } else {
      toast('error', 'Save Failed', 'Could not save HR profile. Please try again.');
    }
  } catch {
    toast('error', 'Connection Error', 'Could not reach backend.');
  } finally {
    btnConfirmProfile.disabled = false;
    setBtn(btnConfirmProfile, 'idle');
  }
});

// ── Init ───────────────────────────────────────────────────────────────────────

btnRefreshRec.addEventListener('click', () => fetchRecommendation(true));
btnSkipToday.addEventListener('click', skipToday);
btnRetryRec.addEventListener('click', () => fetchRecommendation(false));
btnOpenPanelFromRec.addEventListener('click', openPanel);
document.getElementById('btn-generate-first-plan').addEventListener('click', () => {
  fetchRecommendation(true);
});
document.getElementById('btn-cancel-profile').addEventListener('click', closePsModal);
document.getElementById('btn-edit-hr-profile').addEventListener('click', () => {
  closePanel();
  // Open as modal overlay — re-fetches Garmin data for fresh suggestions
  enterProfileSetup(true);
});

// fetchGeminiKeyStatus() fetches setupComplete from the DB and calls maybeEnterDashboard().
// Since the backend is localhost, the transition happens in < 50 ms — imperceptible.
loadDashboard();              // immediate: render whatever is in the DB (no Garmin needed)
checkStatus();                // parallel: check session and enable live features if connected
fetchGeminiKeyStatus();       // fetch geminiConfigured + setupComplete → routes to correct view
fetchRecommendation();        // load recommendation from DB cache immediately
setInterval(checkStatus, 30000);

// 🍦 Mintberry Crunch easter egg — swap logo icon when shablagoo is toggled
const shablagooToggle = document.getElementById('shablagoo-toggle');
if (shablagooToggle) {
  const logoIcons = document.querySelectorAll('.logo-icon');
  shablagooToggle.addEventListener('change', () => {
    logoIcons.forEach(icon => {
      if (shablagooToggle.checked) {
        icon.classList.replace('fa-route', 'fa-ice-cream');
      } else {
        icon.classList.replace('fa-ice-cream', 'fa-route');
      }
    });
  });
}
