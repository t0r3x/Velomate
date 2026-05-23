// API Client for INNERJOIN Dashboard
const API_BASE_URL = 'http://localhost:3001';

// State variables
let isLoggedIn          = false;
let currentProfile      = null;
let suggestedProfile    = null;
let devicesLoaded       = false;
let currentRecommendation = null;

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
const btnSaveGeminiKey    = document.getElementById('btn-save-gemini-key');
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
const aiSyncNote          = document.getElementById('ai-sync-note');

const maxHrInput = document.getElementById('profile-max-hr');
const lthrInput  = document.getElementById('profile-lthr');
const zonesForm  = document.getElementById('zones-form');

const z1Min = document.getElementById('z1-min');
const z1Max = document.getElementById('z1-max');
const z2Min = document.getElementById('z2-min');
const z2Max = document.getElementById('z2-max');
const z3Min = document.getElementById('z3-min');
const z3Max = document.getElementById('z3-max');
const z4Min = document.getElementById('z4-min');
const z4Max = document.getElementById('z4-max');
const z5Min = document.getElementById('z5-min');
const z5Max = document.getElementById('z5-max');

const btnAnalyze        = document.getElementById('btn-analyze');
const assessmentResults = document.getElementById('assessment-results');
const recMaxHr          = document.getElementById('rec-max-hr');
const recLthr           = document.getElementById('rec-lthr');
const btnApplyRec       = document.getElementById('btn-apply-rec');

const activitiesList    = document.getElementById('activities-list');
const deviceSelect      = document.getElementById('device-select');
const btnRefreshDevices = document.getElementById('btn-refresh-devices');
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
  const states = ['not-configured', 'loading', 'loaded', 'error'];
  states.forEach(s => {
    const el = document.getElementById(`rec-state-${s}`);
    if (el) el.classList.toggle('hidden', s !== state);
  });
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

  // Priority badge
  const priority = rec.priority || '';
  aiPriorityBadge.className = `ai-priority-badge priority-${priority.toLowerCase()}`;
  aiPriorityBadge.textContent = priority.charAt(0).toUpperCase() + priority.slice(1);

  // Today reason
  aiTodayReason.textContent = rec.reason || '';

  // Week grid
  const plan = Array.isArray(rec.weeklyPlan) ? rec.weeklyPlan : [];
  aiWeekGrid.innerHTML = '';

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
        cell.querySelector('.wdc-duration').textContent = entry.reason ? '' : '';
        cell.querySelector('.wdc-scheduled-badge').hidden = true;
        // Show a small tooltip via title
        cell.title = entry.reason || '';
      }

      const d = new Date(entry.date + 'T12:00:00');
      cell.querySelector('.wdc-day-label').textContent = DAY_NAMES[d.getDay()];
      cell.querySelector('.wdc-date').textContent      = d.getDate();

      if (isToday)                    cell.classList.add('is-today');
      if (entry.status === 'completed')   cell.classList.add('is-completed');
      if (entry.status === 'skipped' || entry.status === 'auto-skipped')
                                      cell.classList.add('is-skipped');

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

  // Sync note — first planned Threshold in the week
  const threshold = plan.find(e => e.type === 'Threshold' && e.status === 'planned');
  if (threshold && aiSyncNote) {
    const tDate = new Date(threshold.date + 'T12:00:00');
    const tFmt  = tDate.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    aiSyncNote.textContent = `Threshold scheduled for ${tFmt}`;
  } else if (aiSyncNote) {
    aiSyncNote.textContent = '';
  }
};

/** Fetch Gemini key status from backend and update panel UI. */
const fetchGeminiKeyStatus = async () => {
  try {
    const res  = await fetch(`${API_BASE_URL}/api/settings/gemini-key`);
    const data = await res.json();
    if (data.hasKey) {
      geminiKeyStatus.classList.remove('hidden');
      geminiKeyMasked.textContent = data.maskedKey;
    } else {
      geminiKeyStatus.classList.add('hidden');
    }
  } catch {
    // non-critical
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
        document.getElementById('rec-error-msg').textContent = err.details || err.error || 'Failed to get recommendation.';
        setRecState('error');
        return;
      }
      data = await res.json();
    } else {
      const res = await fetch(`${API_BASE_URL}/api/recommendation`);
      data = await res.json();
      if (data.notConfigured) { setRecState('not-configured'); return; }
      if (data.noData)        { return fetchRecommendation(true); } // silent auto-regen
      if (data.stale)         { toast('info', 'Plan updating…', 'Your plan is over 24h old — refreshing.'); }
    }
    renderRecommendation(data);
    setRecState('loaded');
  } catch (err) {
    document.getElementById('rec-error-msg').textContent = 'Failed to connect to backend.';
    setRecState('error');
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
    toast('success', 'Workout skipped', 'Plan updated by Gemini.');
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
    btnSync.disabled    = false;
    btnAnalyze.disabled = false;
    setBtn(btnAnalyze, 'connected');
    if (!devicesLoaded) fetchDevices();
  } else {
    statusDot.className = 'status-dot disconnected';
    statusText.textContent = 'Not connected';
    loggedOutSection.classList.remove('hidden');
    loggedInSection.classList.add('hidden');
    btnSync.disabled    = true;
    btnAnalyze.disabled = true;
    deviceSelect.innerHTML    = '<option value="">Connect to Garmin first…</option>';
    deviceSelect.disabled     = true;
    btnRefreshDevices.disabled = true;
    devicesLoaded             = false;
    garminBtnHrLabel.textContent = '';
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

// Fill inputs with profile data
const populateProfileUI = (profile) => {
  maxHrInput.value = profile.maxHr;
  lthrInput.value  = profile.lthr;

  z1Min.value = profile.zones.z1.min;
  z1Max.value = profile.zones.z1.max;
  z2Min.value = profile.zones.z2.min;
  z2Max.value = profile.zones.z2.max;
  z3Min.value = profile.zones.z3.min;
  z3Max.value = profile.zones.z3.max;
  z4Min.value = profile.zones.z4.min;
  z4Max.value = profile.zones.z4.max;
  z5Min.value = profile.zones.z5.min;
  z5Max.value = profile.zones.z5.max;

  updateZonesVisualizer(profile);
};

// Recalculate segment widths for the stacked zone bar
const updateZonesVisualizer = (profile) => {
  const max  = profile.maxHr || 190;
  const z1Pct = Math.round((profile.zones.z1.max / max) * 100);
  const z2Pct = Math.round(((profile.zones.z2.max - profile.zones.z2.min) / max) * 100);
  const z3Pct = Math.round(((profile.zones.z3.max - profile.zones.z3.min) / max) * 100);
  const z4Pct = Math.round(((profile.zones.z4.max - profile.zones.z4.min) / max) * 100);
  const z5Pct = Math.round(((max - profile.zones.z5.min) / max) * 100);

  const seg = (cls) => document.querySelector(`.zone-bar-segment.${cls}`);

  Object.entries({ z1: z1Pct, z2: z2Pct, z3: z3Pct, z4: z4Pct, z5: z5Pct }).forEach(([z, pct]) => {
    seg(z).style.width = `${pct}%`;
  });
  seg('z1').title = `Zone 1: 0 - ${profile.zones.z1.max} bpm`;
  seg('z2').title = `Zone 2: ${profile.zones.z2.min} - ${profile.zones.z2.max} bpm`;
  seg('z3').title = `Zone 3: ${profile.zones.z3.min} - ${profile.zones.z3.max} bpm`;
  seg('z4').title = `Zone 4: ${profile.zones.z4.min} - ${profile.zones.z4.max} bpm`;
  seg('z5').title = `Zone 5: ${profile.zones.z5.min} - ${profile.maxHr} bpm`;
};

// Auto-compute zone boundaries when Max HR or LTHR change
const autoBoundariesFromInput = () => {
  const lthr  = parseInt(lthrInput.value)  || 165;
  const maxHr = parseInt(maxHrInput.value) || 190;

  const z1Limit = Math.round(lthr * 0.65);
  const z2Limit = Math.round(lthr * 0.80);
  const z3Limit = Math.round(lthr * 0.89);

  z1Max.value = z1Limit;
  z2Min.value = z1Limit + 1;  z2Max.value = z2Limit;
  z3Min.value = z2Limit + 1;  z3Max.value = z3Limit;
  z4Min.value = z3Limit + 1;  z4Max.value = lthr;
  z5Min.value = lthr + 1;     z5Max.value = maxHr;
};

lthrInput.addEventListener('input', autoBoundariesFromInput);
maxHrInput.addEventListener('input', autoBoundariesFromInput);

// Save updated profile
zonesForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btnSave = document.getElementById('btn-save-profile');
  btnSave.disabled = true;
  setBtn(btnSave, 'loading');

  const updatedProfile = {
    maxHr: parseInt(maxHrInput.value),
    lthr:  parseInt(lthrInput.value),
    zones: {
      z1: { min: 0,                     max: parseInt(z1Max.value) },
      z2: { min: parseInt(z2Min.value), max: parseInt(z2Max.value) },
      z3: { min: parseInt(z3Min.value), max: parseInt(z3Max.value) },
      z4: { min: parseInt(z4Min.value), max: parseInt(z4Max.value) },
      z5: { min: parseInt(z5Min.value), max: parseInt(z5Max.value) }
    }
  };

  try {
    const response = await fetch(`${API_BASE_URL}/api/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updatedProfile)
    });

    if (response.ok) {
      currentProfile = updatedProfile;
      updateZonesVisualizer(updatedProfile);
      updateHeaderHrLabel(updatedProfile);
      toast('success', 'Profile Saved', 'Heart rate zones updated successfully.');
    } else {
      toast('error', 'Save Failed', 'Could not save profile to backend.');
    }
  } catch (error) {
    toast('error', 'Connection Error', 'Could not reach backend while saving profile.');
  } finally {
    btnSave.disabled = false;
    setBtn(btnSave, 'idle');
  }
});

// ── Devices ────────────────────────────────────────────────────────────────────

// Populate the device <select> from an array of device objects
const renderDeviceOptions = (devices) => {
  deviceSelect.innerHTML = '';

  if (Array.isArray(devices) && devices.length > 0) {
    // Sort: Edge devices first
    const sorted = [...devices].sort((a, b) => {
      const aEdge = (a.productDisplayName || '').toLowerCase().includes('edge');
      const bEdge = (b.productDisplayName || '').toLowerCase().includes('edge');
      return aEdge === bEdge ? 0 : aEdge ? -1 : 1;
    });

    sorted.forEach(d => {
      const opt  = document.createElement('option');
      opt.value  = d.deviceId || d.unitId || '';
      const name = d.productDisplayName || d.deviceMetaDataDTO?.deviceProductDescription || 'Unknown device';
      const type = d.activityTypes?.join(', ') || d.activityType || '';
      opt.textContent = name + (type ? ` — ${type}` : '');
      deviceSelect.appendChild(opt);
    });

    deviceSelect.disabled      = false;
    btnRefreshDevices.disabled = false;

    // Auto-select first Edge device
    const edgeOpt = [...deviceSelect.options].find(o => o.text.toLowerCase().includes('edge'));
    if (edgeOpt) edgeOpt.selected = true;
  } else {
    const opt       = document.createElement('option');
    opt.textContent = 'No devices found';
    opt.disabled    = true;
    deviceSelect.appendChild(opt);
    btnRefreshDevices.disabled = false;
  }
};

// Fetch devices from backend (served from DB cache; fetches from Garmin only on first use)
const fetchDevices = async () => {
  deviceSelect.innerHTML = '<option value="">Loading devices…</option>';
  deviceSelect.disabled  = true;

  try {
    const response = await fetch(`${API_BASE_URL}/api/devices`);
    if (!response.ok) throw new Error('Devices error');
    renderDeviceOptions(await response.json());
    devicesLoaded = true;
  } catch (error) {
    console.error('Error fetching devices:', error);
    deviceSelect.innerHTML = '<option value="" disabled>Failed to load devices</option>';
  }
};

// Force re-fetch from Garmin and update the DB cache (manual refresh button)
const refreshDevices = async () => {
  btnRefreshDevices.disabled = true;
  btnRefreshDevices.classList.add('spinning');
  deviceSelect.disabled = true;

  try {
    const response = await fetch(`${API_BASE_URL}/api/devices/refresh`, { method: 'POST' });
    if (!response.ok) throw new Error('Refresh error');
    renderDeviceOptions(await response.json());
  } catch (error) {
    console.error('Error refreshing devices:', error);
    deviceSelect.innerHTML     = '<option value="" disabled>Refresh failed</option>';
    btnRefreshDevices.disabled = false;
  } finally {
    btnRefreshDevices.classList.remove('spinning');
  }
};

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

const renderAssessment = (analysis, profile) => {
  if (!analysis || analysis.totalCyclingRides === 0) {
    assessmentResults.classList.add('hidden');
    return;
  }

  const maxHrChanged = analysis.estimatedMaxHr !== profile.maxHr;
  const lthrChanged  = analysis.estimatedLthr  !== profile.lthr;

  if (maxHrChanged || lthrChanged) {
    suggestedProfile = {
      maxHr: analysis.estimatedMaxHr,
      lthr:  analysis.estimatedLthr,
      zones: analysis.suggestedZones
    };

    recMaxHr.textContent = maxHrChanged
      ? `${profile.maxHr} bpm → ${analysis.estimatedMaxHr} bpm`
      : `${profile.maxHr} bpm (unchanged)`;
    recLthr.textContent = lthrChanged
      ? `${profile.lthr} bpm → ${analysis.estimatedLthr} bpm`
      : `${profile.lthr} bpm (unchanged)`;

    document.getElementById('rec-summary-rides').textContent   = analysis.totalCyclingRides;
    document.getElementById('rec-summary-max-hr').textContent  = `${analysis.maxRecordedHr} bpm`;
    document.getElementById('rec-summary-lthr').textContent    = `${analysis.estimatedLthr} bpm`;
    document.getElementById('rec-summary-avg-dur').textContent = `${analysis.averageRideDurationMinutes} minutes`;

    assessmentResults.classList.remove('hidden');
  } else {
    assessmentResults.classList.add('hidden');
    suggestedProfile = null;
  }
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
    renderAssessment(data.analysis, currentProfile || {});
    updateLastSynced(data.analysis);
  } catch (e) {
    console.error('Dashboard load failed:', e);
  }
};

// Refresh from Garmin: fetch new rides, merge into DB, re-render
btnAnalyze.addEventListener('click', async () => {
  btnAnalyze.disabled = true;
  setBtn(btnAnalyze, 'loading');

  try {
    const response = await fetch(`${API_BASE_URL}/api/activities/refresh`, { method: 'POST' });
    const data = await response.json();

    if (!response.ok) {
      toast('error', 'Refresh Failed', data.error || 'Check the server logs.');
      return;
    }

    currentProfile = data.currentProfile || currentProfile;
    renderActivities(data.activities || []);
    renderAssessment(data.analysis, currentProfile);
    updateLastSynced(data.analysis);

    const n = data.newCount || 0;
    toast('success', 'Synced from Garmin',
      `${n} new ${n === 1 ? 'ride' : 'rides'} added — ${data.activities?.length || 0} total stored.`);
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
    li.querySelector('.activity-meta').textContent  = `${dateFormatted} • ${act.type || 'Cycling'}`;
    li.querySelector('.act-stat--dist .act-stat-val').textContent = `${act.distanceKm} km`;
    li.querySelector('.act-stat--time .act-stat-val').textContent = `${act.durationMinutes} min`;

    const hrStat = li.querySelector('.act-stat--hr');
    if (act.averageHr > 0) {
      hrStat.querySelector('.act-stat-val').textContent = `${act.averageHr} bpm`;
    } else {
      hrStat.hidden = true;
    }

    activitiesList.appendChild(li);
  });
};

// Accept and apply suggested HR profile recommendations
btnApplyRec.addEventListener('click', async () => {
  if (!suggestedProfile) return;

  btnApplyRec.disabled = true;
  setBtn(btnApplyRec, 'loading');

  try {
    const response = await fetch(`${API_BASE_URL}/api/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(suggestedProfile)
    });

    if (response.ok) {
      currentProfile = suggestedProfile;
      populateProfileUI(suggestedProfile);
      updateHeaderHrLabel(suggestedProfile);
      assessmentResults.classList.add('hidden');
      toast('success', 'Zones Updated', 'Training zones and heart rate profile applied successfully.');
    } else {
      toast('error', 'Update Failed', 'Could not save the recommended profile.');
    }
  } catch (error) {
    toast('error', 'Connection Error', 'Failed to apply recommendation.');
  } finally {
    btnApplyRec.disabled = false;
    setBtn(btnApplyRec, 'idle');
  }
});

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
      document.getElementById('sync-scheduled-date').textContent = data.scheduledDate;

      syncedWorkoutsList.innerHTML = '';
      const tpl = document.getElementById('tpl-synced-workout');
      data.workouts.forEach(w => {
        const isScheduled = w.type === 'Threshold';
        const li          = tpl.content.cloneNode(true).firstElementChild;
        li.querySelector('.sw-name').textContent = w.name;
        const statusEl = li.querySelector('.sw-status');
        statusEl.textContent = isScheduled
          ? `(Scheduled for ${data.scheduledDate})`
          : '(Available on Device)';
        statusEl.style.color = isScheduled ? 'var(--z4-color)' : 'var(--text-muted)';
        syncedWorkoutsList.appendChild(li);
      });

      syncResult.classList.remove('hidden');
      syncResult.scrollIntoView({ behavior: 'smooth' });
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

// ── Gemini Key Form ────────────────────────────────────────────────────────────

geminiKeyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const key = geminiApiKeyInput.value.trim();
  if (!key) return;

  btnSaveGeminiKey.disabled = true;
  setBtn(btnSaveGeminiKey, 'loading');

  try {
    const res = await fetch(`${API_BASE_URL}/api/settings/gemini-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: key })
    });

    if (res.ok) {
      geminiApiKeyInput.value = '';
      await fetchGeminiKeyStatus();
      closePanel();
      toast('success', 'API Key Saved', 'Gemini is now connected — generating your plan…');
      fetchRecommendation(true);
    } else {
      const err = await res.json();
      toast('error', 'Save Failed', err.error || 'Could not save API key.');
    }
  } catch {
    toast('error', 'Connection Error', 'Could not reach backend while saving API key.');
  } finally {
    btnSaveGeminiKey.disabled = false;
    setBtn(btnSaveGeminiKey, 'idle');
  }
});

// ── Init ───────────────────────────────────────────────────────────────────────

btnRefreshDevices.addEventListener('click', refreshDevices);
btnRefreshRec.addEventListener('click', () => fetchRecommendation(true));
btnSkipToday.addEventListener('click', skipToday);
btnRetryRec.addEventListener('click', () => fetchRecommendation(false));
btnOpenPanelFromRec.addEventListener('click', openPanel);

loadDashboard();              // immediate: render whatever is in the DB (no Garmin needed)
checkStatus();                // parallel: check session and enable live features if connected
fetchGeminiKeyStatus();       // show masked key in panel if already saved
fetchRecommendation();        // load recommendation from DB cache immediately
setInterval(checkStatus, 30000);
