import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import axios from 'axios';
import { getGarminClient, trySessionAuth, loginGarmin } from './services/garmin.service';
import { loadProfile, saveProfile } from './services/profile.service';
import { fetchCyclingActivities, assessProgression } from './services/activity.service';
import { syncAndScheduleWorkouts } from './services/workout.service';
import { UserHRProfile } from './types';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Serve static files from the frontend directory
const frontendPath = path.join(__dirname, '../../frontend');
app.use(express.static(frontendPath));

// --- REST API ENDPOINTS ---

// Check Status
app.get('/api/status', async (req: Request, res: Response) => {
  try {
    const sessionValid = await trySessionAuth();
    res.json({
      loggedIn: sessionValid,
      hasEnvCredentials: !!(process.env.GARMIN_USERNAME && process.env.GARMIN_PASSWORD)
    });
  } catch (error) {
    res.json({ loggedIn: false, error: 'Failed to check status' });
  }
});

import { GarminSSOClient } from './services/sso.service';
import { finalizeLogin } from './services/garmin.service';

// Returns the active Bearer token from the library's injected oauth2Token
const getBearerToken = (): string | null => {
  const client = getGarminClient();
  return (client.client as any).oauth2Token?.access_token ?? null;
};

const garminApi = async (path: string) => {
  const token = getBearerToken();
  if (!token) throw new Error('No active Garmin session.');
  const response = await axios.get(`https://connectapi.garmin.com${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return response.data;
};

// Store pending SSO clients (per user session)
const ssoClients = new Map<string, GarminSSOClient>();
const pendingUsernames = new Map<string, string>();

// Trigger Login
app.post('/api/login', async (req: Request, res: Response) => {
  const { username, password } = req.body;
  try {
    const ssoClient = new GarminSSOClient();
    const result = await ssoClient.initiate(username, password);
    
    if ('mfaRequired' in result) {
      ssoClients.set('last', ssoClient);
      pendingUsernames.set('last', username);
      return res.json({ mfaRequired: true, message: 'MFA code required.' });
    }

    if ('success' in result && result.ticket) {
      await finalizeLogin(result.ticket, ssoClient);
      return res.json({ success: true, message: 'Logged in successfully.' });
    }
    
    res.status(401).json({ error: 'Login failed.' });
  } catch (error: any) {
    console.error('Login failed:', error);
    res.status(401).json({ error: 'Authentication failed.', details: error.message });
  }
});

// Submit MFA Code
app.post('/api/mfa', async (req: Request, res: Response) => {
  const { code } = req.body;
  const ssoClient = ssoClients.get('last');
  
  if (!ssoClient) {
    return res.status(400).json({ error: 'No active MFA session found.' });
  }

  try {
    const result = await ssoClient.verify(code);
    if (result.success && result.ticket) {
      await finalizeLogin(result.ticket, ssoClient);
      ssoClients.delete('last');
      pendingUsernames.delete('last');
      return res.json({ success: true, message: 'MFA verified and logged in.' });
    }
    res.status(401).json({ error: 'MFA verification failed.' });
  } catch (error: any) {
    console.error('MFA failed:', error);
    res.status(401).json({ error: 'MFA failed.', details: error.message });
  }
});

// Get HR Profile / Zones (local config, optionally enriched with Garmin data)
app.get('/api/profile', async (req: Request, res: Response) => {
  const profile = loadProfile();

  // If not customized yet, try to pull maxHR from Garmin user settings
  if (!profile.hasCustomOverrides && getBearerToken()) {
    try {
      const settings = await garminApi('/userprofile-service/userprofile/user-settings/');
      const garminMaxHr = settings?.userData?.maxHrBpm;
      if (garminMaxHr && garminMaxHr > 100) {
        profile.maxHr = garminMaxHr;
        profile.lthr = Math.round(garminMaxHr * 0.87);
        const { calculateDefaultZones } = await import('./services/profile.service');
        profile.zones = calculateDefaultZones(profile.lthr, profile.maxHr);
        console.log(`[Profile] Synced maxHR=${garminMaxHr} from Garmin user settings.`);
      }
    } catch (e) {
      // Non-fatal: fall back to stored defaults
    }
  }

  res.json(profile);
});

// Update HR Profile / Zones manually
app.post('/api/profile', (req: Request, res: Response) => {
  const { maxHr, lthr, zones } = req.body;
  
  if (!maxHr || !lthr || !zones) {
    return res.status(400).json({ error: 'maxHr, lthr, and zones are required.' });
  }

  const profile: UserHRProfile = {
    maxHr,
    lthr,
    zones,
    hasCustomOverrides: true,
    lastUpdated: new Date().toISOString()
  };

  saveProfile(profile);
  res.json({ success: true, profile });
});

// Fetch Activities and auto-assess training level progression
app.get('/api/activities', async (req: Request, res: Response) => {
  try {
    const formattedActivities = await fetchCyclingActivities(90);
    const analysis = assessProgression(formattedActivities);
    const currentProfile = loadProfile();

    res.json({
      activities: formattedActivities,
      analysis,
      currentProfile
    });
  } catch (error: any) {
    console.error('Error fetching activities:', error);
    res.status(error.message.includes('authenticated') ? 401 : 500).json({ 
      error: 'Failed to fetch activities.', 
      details: error.message 
    });
  }
});

// Get registered devices list
app.get('/api/devices', async (req: Request, res: Response) => {
  try {
    const isAuthenticated = await trySessionAuth();
    if (!isAuthenticated) {
      return res.status(401).json({ error: 'Not authenticated with Garmin Connect.' });
    }

    const devices = await garminApi('/device-service/deviceregistration/devices');
    res.json(devices);
  } catch (error: any) {
    console.error('Error fetching devices:', error);
    res.status(500).json({ error: 'Failed to fetch devices.', details: error.message });
  }
});

// Preview workouts (no upload — returns structure + suggested week schedule)
app.get('/api/preview-workouts', async (req: Request, res: Response) => {
  try {
    const profile = loadProfile();

    // Estimate long ride duration from recent activities (non-fatal)
    let longRideDurationMinutes = 120;
    if (getBearerToken()) {
      try {
        const client = getGarminClient();
        const activities = await client.getActivities(0, 20);
        const cycling = activities.filter((a: any) => {
          const tk = (a.activityType?.typeKey || '').toLowerCase();
          return tk.includes('cycl') || tk.includes('bik');
        });
        if (cycling.length > 0) {
          const avgSec = cycling.reduce((s: number, a: any) => s + (a.duration || 0), 0) / cycling.length;
          longRideDurationMinutes = Math.min(240, Math.max(90, Math.round((avgSec / 60) * 1.2)));
        }
      } catch { /* fallback to 120 */ }
    }

    const sprintTotal = Math.round(10 + 6 * (0.5 + 4) + 10);  // 47 min
    const thresholdTotal = Math.round(10 + 3 * (8 + 4) + 10); // 56 min

    const workouts = [
      {
        type: 'Sprint',
        name: `INNERJOIN Sprint — ${profile.lthr} LTHR`,
        totalMinutes: sprintTotal,
        weekOffset: -2,
        steps: [
          { label: 'Warm-up',     duration: '10 min',      zone: 'Z2',    zoneKey: 'z2', minutes: 10 },
          { label: '6× Sprint',   duration: '30 sec each', zone: 'Z5',    zoneKey: 'z5', minutes: 3  },
          { label: '6× Recovery', duration: '4 min each',  zone: 'Z1',    zoneKey: 'z1', minutes: 24 },
          { label: 'Cool-down',   duration: '10 min',      zone: 'Z1',    zoneKey: 'z1', minutes: 10 },
        ]
      },
      {
        type: 'Threshold',
        name: `INNERJOIN Drempel — ${profile.lthr} LTHR`,
        totalMinutes: thresholdTotal,
        weekOffset: 0,
        isScheduled: true,
        steps: [
          { label: 'Warm-up',      duration: '10 min',      zone: 'Z2',    zoneKey: 'z2', minutes: 10 },
          { label: '3× Drempel',   duration: '8 min each',  zone: 'Z4',    zoneKey: 'z4', minutes: 24 },
          { label: '3× Recovery',  duration: '4 min each',  zone: 'Z1/Z2', zoneKey: 'z1', minutes: 12 },
          { label: 'Cool-down',    duration: '10 min',      zone: 'Z1',    zoneKey: 'z1', minutes: 10 },
        ]
      },
      {
        type: 'LongRide',
        name: `INNERJOIN Lange Rit — ${longRideDurationMinutes} min`,
        totalMinutes: longRideDurationMinutes,
        weekOffset: 2,
        steps: [
          { label: 'Duurrit', duration: `${longRideDurationMinutes} min`, zone: 'Z2', zoneKey: 'z2', minutes: longRideDurationMinutes },
        ]
      }
    ];

    res.json({ workouts, profile });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to generate preview.', details: error.message });
  }
});

// Auto-Sync and Schedule scaled workouts
app.post('/api/sync-workouts', async (req: Request, res: Response) => {
  const { scheduleDate } = req.body;
  try {
    const result = await syncAndScheduleWorkouts(scheduleDate);
    res.json({
      success: true,
      message: 'Workouts uploaded and main workout scheduled successfully.',
      ...result
    });
  } catch (error: any) {
    console.error('Error generating and uploading workouts:', error);
    res.status(error.message.includes('authenticated') ? 401 : 500).json({ 
      error: 'Failed to create or schedule workouts.', 
      details: error.message 
    });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`Backend server is running on http://localhost:${PORT}`);
});
