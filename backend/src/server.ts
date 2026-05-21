import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
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

// Store pending SSO clients (per user session)
const ssoClients = new Map<string, GarminSSOClient>();
const pendingUsernames = new Map<string, string>();

// Trigger Login
app.post('/api/login', async (req: Request, res: Response) => {
  const { username, password } = req.body;
  try {
    const ssoClient = new GarminSSOClient();
    const result = await ssoClient.initiate(username, password);
    
    if (result.mfaRequired) {
      ssoClients.set('last', ssoClient);
      pendingUsernames.set('last', username);
      return res.json({ mfaRequired: true, message: 'MFA code required.' });
    }
    
    if (result.success && result.ticket) {
      await finalizeLogin(result.ticket);
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
      await finalizeLogin(result.ticket);
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

// Get HR Profile / Zones
app.get('/api/profile', (req: Request, res: Response) => {
  const profile = loadProfile();
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
    const formattedActivities = await fetchCyclingActivities(30);
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

    const client = getGarminClient();
    const devices = await client.get('/device-service/deviceregistration/devices');
    res.json(devices);
  } catch (error: any) {
    console.error('Error fetching devices:', error);
    res.status(500).json({ error: 'Failed to fetch devices.', details: error.message });
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
