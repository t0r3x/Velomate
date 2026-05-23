// API Client for INNERJOIN Dashboard
const API_BASE_URL = 'http://localhost:3001';

// State variables
let isLoggedIn = false;
let currentProfile = null;
let suggestedProfile = null;

// DOM Elements
const statusDot    = document.getElementById('status-dot');
const statusText   = document.getElementById('status-text');
const btnOpenPanel = document.getElementById('btn-open-panel');
const btnClosePanel= document.getElementById('btn-close-panel');
const settingsPanel= document.getElementById('settings-panel');
const panelOverlay = document.getElementById('panel-overlay');
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

const btnSync          = document.getElementById('btn-sync-workouts');
const scheduleDateInput= document.getElementById('schedule-date');
const syncResult       = document.getElementById('sync-result');
const syncResultMsg    = document.getElementById('sync-result-msg');
const syncedWorkoutsList = document.getElementById('synced-workouts-list');

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

const btnAnalyze       = document.getElementById('btn-analyze');
const assessmentResults= document.getElementById('assessment-results');
const recMaxHr         = document.getElementById('rec-max-hr');
const recLthr          = document.getElementById('rec-lthr');
const recSummaryText   = document.getElementById('rec-summary-text');
const btnApplyRec      = document.getElementById('btn-apply-rec');

const activitiesList   = document.getElementById('activities-list');
const deviceSelect     = document.getElementById('device-select');
const authLoading      = document.getElementById('auth-status-loading');

// ── Side Panel ──────────────────────────────────────────────────
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

// Toast notification system
const toast = (type, title, msg = '', duration = 4000) => {
  const container = document.getElementById('toast-container');
  const icons = { success: 'fa-circle-check', error: 'fa-circle-xmark', info: 'fa-circle-info', warn: 'fa-triangle-exclamation' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<i class="fa-solid ${icons[type] || icons.info} toast-icon"></i>
    <div class="toast-body"><div class="toast-title">${title}</div>${msg ? `<div class="toast-msg">${msg}</div>` : ''}</div>
    <button class="toast-close" onclick="this.closest('.toast').remove()"><i class="fa-solid fa-xmark"></i></button>`;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('removing');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, duration);
};

// ── Week Preview ──────────────────────────────────────────────────
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_NAMES_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

let previewWorkouts = null; // cache from API

const zoneColors = {
  z1: 'var(--z1-color, #6ec6e6)',
  z2: 'var(--z2-color, #6ee68a)',
  z3: 'var(--z3-color, #e6d46e)',
  z4: 'var(--z4-color, #e6a06e)',
  z5: 'var(--z5-color, #e66e6e)'
};

const workoutTypeIcon = { Sprint: 'fa-bolt', Threshold: 'fa-fire-flame-curved', LongRide: 'fa-road' };
const workoutTypeLabel = { Sprint: 'Sprint', Threshold: 'Threshold', LongRide: 'Long Ride' };

const fetchAndRenderPreview = async () => {
  const dateVal = scheduleDateInput.value;
  if (!dateVal) return;

  const weekPreview = document.getElementById('week-preview');
  const weekGrid = document.getElementById('week-grid');
  const weekLabel = document.getElementById('week-label');
  const detailCards = document.getElementById('workout-detail-cards');

  // Fetch preview data (only once or when profile changes)
  if (!previewWorkouts) {
    try {
      const res = await fetch(`${API_BASE_URL}/api/preview-workouts`);
      if (!res.ok) return;
      const data = await res.json();
      previewWorkouts = data.workouts;
    } catch {
      return;
    }
  }

  // Calculate the week that contains the threshold date
  // weekOffset 0 = Threshold, -2 = Sprint, +2 = Long Ride
  const thresholdDate = new Date(dateVal + 'T00:00:00');

  // Build map: offset → workout
  const offsetMap = {};
  previewWorkouts.forEach(w => { offsetMap[w.weekOffset] = w; });

  // Show Mon–Sun of the week containing thresholdDate
  const dayOfWeek = thresholdDate.getDay(); // 0=Sun,1=Mon,...6=Sat
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(thresholdDate);
  monday.setDate(thresholdDate.getDate() + mondayOffset);

  // Week label
  const fmt = d => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
  weekLabel.textContent = `${fmt(monday)} – ${fmt(sunday)}`;

  // Build grid cells (Mon=0 … Sun=6, offset from Monday)
  weekGrid.innerHTML = '';
  detailCards.innerHTML = '';

  // Map workouts by their absolute date offset from threshold
  // Sprint: threshold - 2 days, Threshold: threshold + 0, LongRide: threshold + 2
  const workoutByDate = {};
  previewWorkouts.forEach(w => {
    const d = new Date(thresholdDate);
    d.setDate(d.getDate() + w.weekOffset);
    workoutByDate[d.toDateString()] = w;
  });

  const today = new Date(); today.setHours(0,0,0,0);

  for (let i = 0; i < 7; i++) {
    const cellDate = new Date(monday);
    cellDate.setDate(monday.getDate() + i);
    const workout = workoutByDate[cellDate.toDateString()];
    const isToday = cellDate.toDateString() === today.toDateString();
    const isThreshold = workout?.type === 'Threshold';

    const cell = document.createElement('div');
    cell.className = 'week-day-cell' +
      (workout ? ` has-workout wt-${workout.type.toLowerCase()}` : ' rest') +
      (isToday ? ' is-today' : '') +
      (isThreshold ? ' is-threshold' : '');

    const dayLabel = DAY_NAMES[cellDate.getDay()];
    const dateNum = cellDate.getDate();

    if (workout) {
      const icon = workoutTypeIcon[workout.type] || 'fa-dumbbell';
      const label = workoutTypeLabel[workout.type] || workout.type;
      cell.innerHTML = `
        <div class="wdc-day">${dayLabel} <span class="wdc-date">${dateNum}</span></div>
        <div class="wdc-workout-chip">
          <i class="fa-solid ${icon}"></i>
          <span>${label}</span>
        </div>
        <div class="wdc-duration">${workout.totalMinutes} min</div>
        ${isThreshold ? '<div class="wdc-scheduled-badge"><i class="fa-solid fa-calendar-check"></i> Scheduled</div>' : ''}
      `;
    } else {
      cell.innerHTML = `
        <div class="wdc-day">${dayLabel} <span class="wdc-date">${dateNum}</span></div>
        <div class="wdc-rest"><i class="fa-solid fa-bed"></i> Rest</div>
      `;
    }
    weekGrid.appendChild(cell);
  }

  // Render detail cards for each workout
  previewWorkouts.forEach(w => {
    const card = document.createElement('div');
    card.className = `workout-card wt-${w.type.toLowerCase()}`;

    const icon = workoutTypeIcon[w.type] || 'fa-dumbbell';
    const label = workoutTypeLabel[w.type] || w.type;

    // Zone bar
    const totalMin = w.totalMinutes;
    const barSegments = w.steps.map(s => {
      const pct = Math.round((s.minutes / totalMin) * 100);
      const color = zoneColors[s.zoneKey] || '#888';
      return `<div class="wc-bar-seg" style="width:${pct}%;background:${color}" title="${s.label} (${s.zone})"></div>`;
    }).join('');

    // Step list
    const stepRows = w.steps.map(s => `
      <div class="wc-step-row">
        <span class="wc-step-dot" style="background:${zoneColors[s.zoneKey]}"></span>
        <span class="wc-step-label">${s.label}</span>
        <span class="wc-step-dur">${s.duration}</span>
        <span class="wc-step-zone zone-tag ${s.zoneKey}">${s.zone}</span>
      </div>
    `).join('');

    // Date for this workout
    const wDate = new Date(thresholdDate);
    wDate.setDate(wDate.getDate() + w.weekOffset);
    const wDateLabel = wDate.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

    card.innerHTML = `
      <div class="wc-header">
        <i class="fa-solid ${icon} wc-icon"></i>
        <div class="wc-title-block">
          <span class="wc-title">${label}</span>
          <span class="wc-date">${wDateLabel}</span>
        </div>
        <span class="wc-total-dur">${w.totalMinutes} min</span>
      </div>
      <div class="wc-zone-bar">${barSegments}</div>
      <div class="wc-steps">${stepRows}</div>
      ${w.isScheduled ? '<div class="wc-schedule-note"><i class="fa-solid fa-calendar-check"></i> Will be scheduled on Garmin Connect</div>' : '<div class="wc-schedule-note muted"><i class="fa-solid fa-upload"></i> Will be uploaded to device</div>'}
    `;
    detailCards.appendChild(card);
  });

  weekPreview.classList.remove('hidden');
};

// Initialize tomorrow's date in target schedule input
const initDateInput = () => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  scheduleDateInput.value = tomorrow.toISOString().split('T')[0];
};

// Check connection and session status on the backend
const checkStatus = async () => {
  try {
    const response = await fetch(`${API_BASE_URL}/api/status`);
    const data = await response.json();
    isLoggedIn = data.loggedIn;
    updateAuthUI(data.loggedIn);
  } catch (error) {
    console.error('Failed to connect to backend service:', error);
    statusDot.className = 'status-dot disconnected';
    statusText.textContent = 'Server Offline';
    btnSync.disabled = true;
    btnAnalyze.disabled = true;
  }
};

// Update Authentication UI elements
const updateAuthUI = (loggedIn) => {
  // Hide the loading skeleton now that status is known
  authLoading.classList.add('hidden');

  if (loggedIn) {
    statusDot.className = 'status-dot connected';
    statusText.textContent = 'Connected';
    loggedOutSection.classList.add('hidden');
    loggedInSection.classList.remove('hidden');
    btnSync.disabled = false;
    btnAnalyze.disabled = false;
    btnAnalyze.innerHTML = '<span>Refresh from Garmin</span> <i class="fa-solid fa-rotate"></i>';
    previewWorkouts = null; // invalidate so preview re-fetches with fresh profile
    fetchDevices();
    fetchAndRenderPreview();
  } else {
    statusDot.className = 'status-dot disconnected';
    statusText.textContent = 'Not connected';
    loggedOutSection.classList.remove('hidden');
    loggedInSection.classList.add('hidden');
    btnSync.disabled = true;
    btnAnalyze.disabled = true;
    deviceSelect.innerHTML = '<option value="">Connect to Garmin first…</option>';
    deviceSelect.disabled = true;
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
  
  // If MFA section is visible and we have a code, send it to the MFA endpoint
  if (!mfaSection.classList.contains('hidden') && mfaCode) {
    btnLogin.disabled = true;
    btnLogin.innerHTML = '<span>Verifying...</span> <i class="fa-solid fa-spinner fa-spin"></i>';
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
      btnLogin.innerHTML = '<span>Connect Garmin</span> <i class="fa-solid fa-arrow-right-to-bracket"></i>';
    }
    return;
  }

  btnLogin.disabled = true;
  btnLogin.innerHTML = '<span>Connecting...</span> <i class="fa-solid fa-spinner fa-spin"></i>';

  try {
    const response = await fetch(`${API_BASE_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: usernameInput.value,
        password: passwordInput.value
      })
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
    btnLogin.innerHTML = '<span>Connect Garmin</span> <i class="fa-solid fa-arrow-right-to-bracket"></i>';
  }
});

// Logout handles simple local toggle (deleting cookies is on backend restarts or manual session delete)
btnLogout.addEventListener('click', () => {
  isLoggedIn = false;
  updateAuthUI(false);
});

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
  lthrInput.value = profile.lthr;
  
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

// Recalculate segment widths for visually stacked bar chart representation
const updateZonesVisualizer = (profile) => {
  const max = profile.maxHr || 190;
  
  const z1Pct = Math.round((profile.zones.z1.max / max) * 100);
  const z2Pct = Math.round(((profile.zones.z2.max - profile.zones.z2.min) / max) * 100);
  const z3Pct = Math.round(((profile.zones.z3.max - profile.zones.z3.min) / max) * 100);
  const z4Pct = Math.round(((profile.zones.z4.max - profile.zones.z4.min) / max) * 100);
  const z5Pct = Math.round(((max - profile.zones.z5.min) / max) * 100);

  const segmentZ1 = document.querySelector('.zone-bar-segment.z1');
  const segmentZ2 = document.querySelector('.zone-bar-segment.z2');
  const segmentZ3 = document.querySelector('.zone-bar-segment.z3');
  const segmentZ4 = document.querySelector('.zone-bar-segment.z4');
  const segmentZ5 = document.querySelector('.zone-bar-segment.z5');

  segmentZ1.style.width = `${z1Pct}%`;
  segmentZ1.title = `Zone 1: 0 - ${profile.zones.z1.max} bpm`;

  segmentZ2.style.width = `${z2Pct}%`;
  segmentZ2.title = `Zone 2: ${profile.zones.z2.min} - ${profile.zones.z2.max} bpm`;

  segmentZ3.style.width = `${z3Pct}%`;
  segmentZ3.title = `Zone 3: ${profile.zones.z3.min} - ${profile.zones.z3.max} bpm`;

  segmentZ4.style.width = `${z4Pct}%`;
  segmentZ4.title = `Zone 4: ${profile.zones.z4.min} - ${profile.zones.z4.max} bpm`;

  segmentZ5.style.width = `${z5Pct}%`;
  segmentZ5.title = `Zone 5: ${profile.zones.z5.min} - ${profile.maxHr} bpm`;
};

// Automatic calculations boundaries when Max HR or LTHR change
const autoBoundariesFromInput = () => {
  const lthr = parseInt(lthrInput.value) || 165;
  const maxHr = parseInt(maxHrInput.value) || 190;
  
  // Calculate defaults:
  // Z1: <65% LTHR
  const z1Limit = Math.round(lthr * 0.65);
  // Z2: 65-80% LTHR
  const z2Start = z1Limit + 1;
  const z2Limit = Math.round(lthr * 0.80);
  // Z3: 80-89% LTHR
  const z3Start = z2Limit + 1;
  const z3Limit = Math.round(lthr * 0.89);
  // Z4: 89-100% LTHR
  const z4Start = z3Limit + 1;
  const z4Limit = lthr;
  // Z5: >100% LTHR up to Max HR
  const z5Start = z4Limit + 1;
  const z5Limit = maxHr;

  z1Max.value = z1Limit;
  z2Min.value = z2Start;
  z2Max.value = z2Limit;
  z3Min.value = z3Start;
  z3Max.value = z3Limit;
  z4Min.value = z4Start;
  z4Max.value = z4Limit;
  z5Min.value = z5Start;
  z5Max.value = z5Limit;
};

// Add listeners to auto-compute boundary inputs on change
lthrInput.addEventListener('input', autoBoundariesFromInput);
maxHrInput.addEventListener('input', autoBoundariesFromInput);

// Save updated profile
zonesForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btnSave = document.getElementById('btn-save-profile');
  btnSave.disabled = true;
  btnSave.innerHTML = '<span>Saving...</span> <i class="fa-solid fa-spinner fa-spin"></i>';

  const updatedProfile = {
    maxHr: parseInt(maxHrInput.value),
    lthr: parseInt(lthrInput.value),
    zones: {
      z1: { min: 0, max: parseInt(z1Max.value) },
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
      previewWorkouts = null; // invalidate so next preview re-fetches with new LTHR
      toast('success', 'Profile Saved', 'Heart rate zones updated successfully.');
    } else {
      toast('error', 'Save Failed', 'Could not save profile to backend.');
    }
  } catch (error) {
    toast('error', 'Connection Error', 'Could not reach backend while saving profile.');
  } finally {
    btnSave.disabled = false;
    btnSave.innerHTML = '<span>Save Heart Rate Profile</span> <i class="fa-solid fa-floppy-disk"></i>';
  }
});

// Fetch Garmin Devices and populate dropdown
const fetchDevices = async () => {
  deviceSelect.innerHTML = '<option value="">Loading devices…</option>';
  deviceSelect.disabled = true;

  try {
    const response = await fetch(`${API_BASE_URL}/api/devices`);
    if (!response.ok) throw new Error('Devices error');

    const devices = await response.json();
    deviceSelect.innerHTML = '';

    if (Array.isArray(devices) && devices.length > 0) {
      // Sort: Edge-devices first
      const sorted = [...devices].sort((a, b) => {
        const aEdge = (a.productDisplayName || '').toLowerCase().includes('edge');
        const bEdge = (b.productDisplayName || '').toLowerCase().includes('edge');
        return aEdge === bEdge ? 0 : aEdge ? -1 : 1;
      });

      sorted.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.deviceId || d.unitId || '';
        const name = d.productDisplayName || d.deviceMetaDataDTO?.deviceProductDescription || 'Unknown device';
        const type = d.activityTypes?.join(', ') || d.activityType || '';
        opt.textContent = name + (type ? ` — ${type}` : '');
        deviceSelect.appendChild(opt);
      });

      deviceSelect.disabled = false;

      // Auto-select first Edge device
      const edgeOpt = [...deviceSelect.options].find(o => o.text.toLowerCase().includes('edge'));
      if (edgeOpt) edgeOpt.selected = true;

    } else {
      const opt = document.createElement('option');
      opt.textContent = 'No devices found';
      opt.disabled = true;
      deviceSelect.appendChild(opt);
    }
  } catch (error) {
    console.error('Error discovering devices:', error);
    deviceSelect.innerHTML = '<option value="" disabled>Failed to load devices</option>';
  }
};

// ── Shared assessment/render helpers ─────────────────────────────────────────

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
    recSummaryText.innerHTML = `Based on your <strong>${analysis.totalCyclingRides} recent rides</strong>, your peak recorded heart rate was <strong>${analysis.maxRecordedHr} bpm</strong>. We estimate your threshold at <strong>${analysis.estimatedLthr} bpm</strong> with an average ride duration of <strong>${analysis.averageRideDurationMinutes} minutes</strong>.`;

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
  btnAnalyze.innerHTML = '<span>Syncing from Garmin…</span> <i class="fa-solid fa-spinner fa-spin"></i>';

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
    btnAnalyze.innerHTML = '<span>Refresh from Garmin</span> <i class="fa-solid fa-rotate"></i>';
  }
});

// Render recent rides list
const renderActivities = (activities) => {
  activitiesList.innerHTML = '';
  
  if (!activities || activities.length === 0) {
    activitiesList.innerHTML = '<p class="helper-text empty-state-text">No recent cycling activities found.</p>';
    return;
  }

  activities.forEach(act => {
    const li = document.createElement('li');
    li.className = 'activity-item';
    
    const dateFormatted = new Date(act.startTime).toLocaleDateString('en-GB', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    li.innerHTML = `
      <div class="activity-icon-container">
        <i class="fa-solid fa-bicycle"></i>
      </div>
      <div class="activity-details-main">
        <span class="activity-title">${act.name || 'Cycling Activity'}</span>
        <span class="activity-meta">${dateFormatted} • ${act.type || 'Cycling'}</span>
      </div>
      <div class="activity-stats-summary">
        <div class="act-stat">
          <span class="act-stat-val">${act.distanceKm} km</span>
          <span class="act-stat-label">Dist</span>
        </div>
        <div class="act-stat">
          <span class="act-stat-val">${act.durationMinutes} min</span>
          <span class="act-stat-label">Time</span>
        </div>
        ${act.averageHr > 0 ? `
          <div class="act-stat">
            <span class="act-stat-val">${act.averageHr} bpm</span>
            <span class="act-stat-label">Avg HR</span>
          </div>
        ` : ''}
      </div>
    `;
    activitiesList.appendChild(li);
  });
};

// Accept and apply suggested HR profile recommendations
btnApplyRec.addEventListener('click', async () => {
  if (!suggestedProfile) return;

  btnApplyRec.disabled = true;
  btnApplyRec.innerHTML = '<span>Applying...</span> <i class="fa-solid fa-spinner fa-spin"></i>';

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
      previewWorkouts = null;
      toast('success', 'Zones Updated', 'Training zones and heart rate profile applied successfully.');
    } else {
      toast('error', 'Update Failed', 'Could not save the recommended profile.');
    }
  } catch (error) {
    toast('error', 'Connection Error', 'Failed to apply recommendation.');
  } finally {
    btnApplyRec.disabled = false;
    btnApplyRec.innerHTML = '<span>Accept & Update Zones</span> <i class="fa-solid fa-check-double"></i>';
  }
});

// Compile, Upload, and Schedule Workouts
btnSync.addEventListener('click', async () => {
  btnSync.disabled = true;
  btnSync.innerHTML = '<span>Syncing Workouts...</span> <i class="fa-solid fa-spinner fa-spin"></i>';
  syncResult.classList.add('hidden');

  const scheduleDate = scheduleDateInput.value;

  try {
    const response = await fetch(`${API_BASE_URL}/api/sync-workouts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scheduleDate })
    });
    
    const data = await response.json();
    
    if (response.ok) {
      syncResultMsg.innerHTML = `Created and uploaded <strong>3 custom HR workouts</strong> to Garmin. The main threshold workout has been scheduled for <strong>${data.scheduledDate}</strong>. Sync your device to apply!`;
      
      syncedWorkoutsList.innerHTML = '';
      data.workouts.forEach(w => {
        const isScheduled = w.type === 'Threshold';
        const li = document.createElement('li');
        li.innerHTML = `Workout <strong>${w.name}</strong> ${isScheduled ? `<span style="color:var(--z4-color)">(Scheduled for ${data.scheduledDate})</span>` : '<span style="color:var(--text-muted)">(Available on Device)</span>'}`;
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
    btnSync.innerHTML = '<span>Sync & Schedule Workouts</span> <i class="fa-solid fa-cloud-arrow-up"></i>';
  }
});

// Re-render week preview whenever date changes
scheduleDateInput.addEventListener('change', fetchAndRenderPreview);

// Initialize dashboard
initDateInput();
loadDashboard();   // immediate: render whatever is in the DB (no Garmin needed)
checkStatus();     // parallel: check session and enable live features if connected
setInterval(checkStatus, 30000);
