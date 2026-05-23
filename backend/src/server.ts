import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import axios from 'axios';
import { getGarminClient, trySessionAuth } from './services/garmin.service';
import { GarminSSOClient } from './services/sso.service';
import { finalizeLogin } from './services/garmin.service';
import { loadProfile, saveProfile, calculateDefaultZones } from './services/profile.service';
import { fetchCyclingActivities, assessProgression } from './services/activity.service';
import { syncAndScheduleWorkouts } from './services/workout.service';
import {
  upsertActivities,
  getStoredActivities,
  upsertAnalysis,
  getStoredAnalysis,
  upsertProfileDB,
  getStoredProfile,
  upsertDevices,
  getStoredDevices,
  hasStoredDevices
} from './services/database.service';
import { UserHRProfile } from './types';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Serve static files from the frontend directory
const frontendPath = path.join(__dirname, '../../frontend');
app.use(express.static(frontendPath));

// ── Helpers ───────────────────────────────────────────────────────────────────

const getBearerToken = (): string | null => {
  const client = getGarminClient();
  return (client.client as any).oauth2Token?.access_token ?? null;
};

const garminApi = async (apiPath: string) => {
  const token = getBearerToken();
  if (!token) throw new Error('No active Garmin session.');
  const response = await axios.get(`https://connectapi.garmin.com${apiPath}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return response.data;
};

// Returns the active HR profile: DB → config.json fallback → defaults
const getActiveProfile = async (): Promise<UserHRProfile> => {
  const dbProfile = getStoredProfile();
  if (dbProfile) return dbProfile;

  // Fallback: load from config.json and migrate to DB
  const fileProfile = loadProfile();
  upsertProfileDB(fileProfile);
  return fileProfile;
};

// ── On-startup migration: move config.json profile to DB if DB is empty ───────
(async () => {
  try {
    if (!getStoredProfile()) {
      const fileProfile = loadProfile();
      if (fileProfile) {
        upsertProfileDB(fileProfile);
        console.log('[DB] Migrated profile from config.json to database.');
      }
    }
  } catch (e) {
    console.warn('[DB] Profile migration skipped:', e);
  }
})();

// ── Auth ──────────────────────────────────────────────────────────────────────

const ssoClients = new Map<string, GarminSSOClient>();

app.get('/api/status', async (req: Request, res: Response) => {
  try {
    const sessionValid = await trySessionAuth();
    res.json({ loggedIn: sessionValid });
  } catch {
    res.json({ loggedIn: false });
  }
});

app.post('/api/login', async (req: Request, res: Response) => {
  const { username, password } = req.body;
  try {
    const ssoClient = new GarminSSOClient();
    const result = await ssoClient.initiate(username, password);

    if ('mfaRequired' in result) {
      ssoClients.set('last', ssoClient);
      return res.json({ mfaRequired: true });
    }
    if ('success' in result && result.ticket) {
      await finalizeLogin(result.ticket, ssoClient);
      return res.json({ success: true });
    }
    res.status(401).json({ error: 'Login failed.' });
  } catch (error: any) {
    res.status(401).json({ error: 'Authentication failed.', details: error.message });
  }
});

app.post('/api/mfa', async (req: Request, res: Response) => {
  const { code } = req.body;
  const ssoClient = ssoClients.get('last');
  if (!ssoClient) return res.status(400).json({ error: 'No active MFA session.' });

  try {
    const result = await ssoClient.verify(code);
    if (result.success && result.ticket) {
      await finalizeLogin(result.ticket, ssoClient);
      ssoClients.delete('last');
      return res.json({ success: true });
    }
    res.status(401).json({ error: 'MFA verification failed.' });
  } catch (error: any) {
    res.status(401).json({ error: 'MFA failed.', details: error.message });
  }
});

// ── Dashboard — single endpoint for initial page load ─────────────────────────
// Returns all persisted data (no Garmin call). Fast, always works offline.
app.get('/api/dashboard', async (req: Request, res: Response) => {
  try {
    const activities = getStoredActivities();
    const analysis   = getStoredAnalysis();
    const profile    = await getActiveProfile();
    res.json({ activities, analysis, profile });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to load dashboard data.', details: error.message });
  }
});

// ── Profile ───────────────────────────────────────────────────────────────────

app.get('/api/profile', async (req: Request, res: Response) => {
  try {
    const profile = await getActiveProfile();

    // If not customised yet, try to enrich from Garmin user settings
    if (!profile.hasCustomOverrides && getBearerToken()) {
      try {
        const settings   = await garminApi('/userprofile-service/userprofile/user-settings/');
        const garminMaxHr = settings?.userData?.maxHrBpm;
        if (garminMaxHr && garminMaxHr > 100) {
          profile.maxHr = garminMaxHr;
          profile.lthr  = Math.round(garminMaxHr * 0.87);
          profile.zones = calculateDefaultZones(profile.lthr, profile.maxHr);
          upsertProfileDB(profile);
          console.log(`[Profile] Synced maxHR=${garminMaxHr} from Garmin.`);
        }
      } catch { /* non-fatal */ }
    }

    res.json(profile);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to load profile.', details: error.message });
  }
});

app.post('/api/profile', async (req: Request, res: Response) => {
  const { maxHr, lthr, zones } = req.body;
  if (!maxHr || !lthr || !zones) {
    return res.status(400).json({ error: 'maxHr, lthr, and zones are required.' });
  }

  const profile: UserHRProfile = {
    maxHr, lthr, zones,
    hasCustomOverrides: true,
    lastUpdated: new Date().toISOString()
  };

  upsertProfileDB(profile);
  saveProfile(profile); // keep config.json in sync for backward compat
  res.json({ success: true, profile });
});

// ── Activities ────────────────────────────────────────────────────────────────

// Return stored activities + analysis (no Garmin call)
app.get('/api/activities', async (req: Request, res: Response) => {
  try {
    const activities = getStoredActivities();
    const analysis   = getStoredAnalysis();
    const profile    = await getActiveProfile();
    res.json({ activities, analysis, currentProfile: profile });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to load activities.', details: error.message });
  }
});

// Pull fresh data from Garmin, merge into DB, re-run analysis
app.post('/api/activities/refresh', async (req: Request, res: Response) => {
  try {
    const isAuthenticated = await trySessionAuth();
    if (!isAuthenticated) {
      return res.status(401).json({ error: 'Not authenticated with Garmin Connect.' });
    }

    console.log('[Refresh] Fetching cycling activities from Garmin...');
    const freshActivities = await fetchCyclingActivities(365); // fetch up to 1 year
    upsertActivities(freshActivities);
    console.log(`[Refresh] Merged ${freshActivities.length} activities into DB.`);

    // Re-run assessment over all stored activities (use recent 90 days for analysis)
    const allStored      = getStoredActivities();
    const cutoff         = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
    const recentForAnalysis = allStored.filter(a =>
      a.startTime ? new Date(a.startTime) >= cutoff : true
    );

    const analysis  = assessProgression(recentForAnalysis);
    upsertAnalysis(analysis);

    const profile = await getActiveProfile();

    res.json({
      activities:    allStored,
      analysis,
      currentProfile: profile,
      newCount:      freshActivities.length
    });
  } catch (error: any) {
    console.error('[Refresh] Error:', error);
    res.status(error.message.includes('authenticated') ? 401 : 500).json({
      error: 'Failed to refresh activities.',
      details: error.message
    });
  }
});

// ── Devices ───────────────────────────────────────────────────────────────────

// GET /api/devices — serve from DB cache; fetch from Garmin only on first use
app.get('/api/devices', async (req: Request, res: Response) => {
  try {
    const isAuthenticated = await trySessionAuth();
    if (!isAuthenticated) return res.status(401).json({ error: 'Not authenticated.' });

    if (hasStoredDevices()) {
      return res.json(getStoredDevices());
    }

    // First time: fetch from Garmin and persist
    const devices = await garminApi('/device-service/deviceregistration/devices');
    if (Array.isArray(devices) && devices.length > 0) {
      upsertDevices(devices);
    }
    res.json(devices);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch devices.', details: error.message });
  }
});

// POST /api/devices/refresh — force re-fetch from Garmin and update cache
app.post('/api/devices/refresh', async (req: Request, res: Response) => {
  try {
    const isAuthenticated = await trySessionAuth();
    if (!isAuthenticated) return res.status(401).json({ error: 'Not authenticated.' });

    const devices = await garminApi('/device-service/deviceregistration/devices');
    if (Array.isArray(devices) && devices.length > 0) {
      upsertDevices(devices);
    }
    res.json(devices);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to refresh devices.', details: error.message });
  }
});

// ── Workout Preview ───────────────────────────────────────────────────────────

app.get('/api/preview-workouts', async (req: Request, res: Response) => {
  try {
    const profile = await getActiveProfile();

    // Estimate long ride duration from stored activities (no live Garmin call needed)
    let longRideDurationMinutes = 120;
    try {
      const stored = getStoredActivities();
      if (stored.length > 0) {
        const recent = stored.slice(0, 20);
        const avgMin = recent.reduce((s, a) => s + (a.durationMinutes || 0), 0) / recent.length;
        longRideDurationMinutes = Math.min(240, Math.max(90, Math.round(avgMin * 1.2)));
      }
    } catch { /* use default */ }

    const sprintTotal    = Math.round(10 + 6 * (0.5 + 4) + 10); // 47 min
    const thresholdTotal = Math.round(10 + 3 * (8 + 4) + 10);   // 56 min

    const workouts = [
      {
        type: 'Sprint',
        name: `INNERJOIN Sprint — ${profile.lthr} LTHR`,
        totalMinutes: sprintTotal,
        weekOffset: -2,
        steps: [
          { label: 'Warm-up',     duration: '10 min',      zone: 'Z2', zoneKey: 'z2', minutes: 10 },
          { label: '6× Sprint',   duration: '30 sec each', zone: 'Z5', zoneKey: 'z5', minutes: 3  },
          { label: '6× Recovery', duration: '4 min each',  zone: 'Z1', zoneKey: 'z1', minutes: 24 },
          { label: 'Cool-down',   duration: '10 min',      zone: 'Z1', zoneKey: 'z1', minutes: 10 },
        ]
      },
      {
        type: 'Threshold',
        name: `INNERJOIN Threshold — ${profile.lthr} LTHR`,
        totalMinutes: thresholdTotal,
        weekOffset: 0,
        isScheduled: true,
        steps: [
          { label: 'Warm-up',       duration: '10 min',     zone: 'Z2',    zoneKey: 'z2', minutes: 10 },
          { label: '3× Threshold',  duration: '8 min each', zone: 'Z4',    zoneKey: 'z4', minutes: 24 },
          { label: '3× Recovery',   duration: '4 min each', zone: 'Z1/Z2', zoneKey: 'z1', minutes: 12 },
          { label: 'Cool-down',     duration: '10 min',     zone: 'Z1',    zoneKey: 'z1', minutes: 10 },
        ]
      },
      {
        type: 'LongRide',
        name: `INNERJOIN Long Ride — ${longRideDurationMinutes} min`,
        totalMinutes: longRideDurationMinutes,
        weekOffset: 2,
        steps: [
          { label: 'Steady Endurance', duration: `${longRideDurationMinutes} min`, zone: 'Z2', zoneKey: 'z2', minutes: longRideDurationMinutes },
        ]
      }
    ];

    res.json({ workouts, profile });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to generate preview.', details: error.message });
  }
});

// ── Sync Workouts ─────────────────────────────────────────────────────────────

app.post('/api/sync-workouts', async (req: Request, res: Response) => {
  const { scheduleDate } = req.body;
  try {
    const result = await syncAndScheduleWorkouts(scheduleDate);
    res.json({ success: true, ...result });
  } catch (error: any) {
    res.status(error.message.includes('authenticated') ? 401 : 500).json({
      error: 'Failed to create or schedule workouts.',
      details: error.message
    });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
