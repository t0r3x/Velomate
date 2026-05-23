import { GarminConnect } from '@flow-js/garmin-connect';
import axios from 'axios';
import { GarminSSOClient } from './sso.service';
import { getSetting, setSetting } from './database.service';

const OAUTH1_KEY = 'garmin_oauth1_token';
const OAUTH2_KEY = 'garmin_oauth2_token';

let gcClient: GarminConnect | null = null;

// ── Auth result cache ──────────────────────────────────────────────────────────
// Prevents a live Garmin API call on every /api/status poll (every 30 s).
// Valid sessions are cached for 5 min; failed checks for 2 min.
interface AuthCache { valid: boolean; expiresAt: number; }
let authCache: AuthCache | null = null;
const AUTH_TTL_SUCCESS = 5 * 60 * 1000;   // 5 minutes
const AUTH_TTL_FAILURE = 2 * 60 * 1000;   // 2 minutes

/** Call on logout: clears in-memory cache and removes stored tokens from DB. */
export const invalidateAuthCache = (): void => {
  authCache = null;
  setSetting(OAUTH1_KEY, '');
  setSetting(OAUTH2_KEY, '');
  gcClient = null; // force a fresh client instance on next use
};

export const getGarminClient = (): GarminConnect => {
  if (!gcClient) {
    const username = process.env.GARMIN_USERNAME || 'placeholder@example.com';
    const password = process.env.GARMIN_PASSWORD || 'placeholder';
    gcClient = new GarminConnect({ username, password });
  }
  return gcClient;
};

const hasStoredTokens = (): boolean => {
  const o1 = getSetting(OAUTH1_KEY);
  const o2 = getSetting(OAUTH2_KEY);
  return !!(o1 && o1.length > 2 && o2 && o2.length > 2);
};

export const hasCachedSession = (): boolean => hasStoredTokens();

export const trySessionAuth = async (): Promise<boolean> => {
  // Return cached result while still fresh — avoids live Garmin call every 30 s
  if (authCache && Date.now() < authCache.expiresAt) {
    return authCache.valid;
  }

  const client = getGarminClient();
  try {
    if (hasStoredTokens()) {
      const oauth1Str = getSetting(OAUTH1_KEY)!;
      const oauth2Str = getSetting(OAUTH2_KEY)!;
      (client.client as any).oauth1Token = JSON.parse(oauth1Str);
      (client.client as any).oauth2Token = JSON.parse(oauth2Str);
      await client.getUserSettings();
      console.log('Successfully authenticated using DB-stored tokens.');
      authCache = { valid: true, expiresAt: Date.now() + AUTH_TTL_SUCCESS };
      return true;
    }
  } catch (error) {
    console.warn('Stored session is invalid or expired.');
  }
  authCache = { valid: false, expiresAt: Date.now() + AUTH_TTL_FAILURE };
  return false;
};

export const loginGarmin = async (username?: string, password?: string): Promise<void> => {
  const client = getGarminClient();
  const user = username || process.env.GARMIN_USERNAME;
  const pass = password || process.env.GARMIN_PASSWORD;

  if (!user || !pass) throw new Error('Username and password are required.');

  console.log(`Attempting login for user: ${user}`);
  await client.login(user, pass);
  console.log('Login successful.');
};

/**
 * Exchange a Garmin CAS serviceTicketId for a DI Bearer token.
 * This mirrors the ha-garmin Python library's token exchange approach,
 * which is compatible with tickets from both the portal and mobile JSON APIs.
 */
async function exchangeTicketForDIToken(ticket: string, serviceUrl: string): Promise<any> {
  const clientIds = [
    'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2',
    'GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4',
    'GARMIN_CONNECT_MOBILE_ANDROID_DI',
    'GARMIN_CONNECT_MOBILE_IOS_DI'
  ];

  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': 'GCM-Android-5.23',
    'X-Garmin-User-Agent': 'com.garmin.android.apps.connectmobile/5.23; ; Google/sdk_gphone64_arm64/google; Android/33; Dalvik/2.1.0',
    'X-Garmin-Paired-App-Version': '10861',
    'X-Garmin-Client-Platform': 'Android',
    'X-App-Ver': '10861',
    'X-Lang': 'en',
    'Accept-Language': 'en-US,en;q=0.9'
  };

  for (const clientId of clientIds) {
    try {
      const credentials = Buffer.from(`${clientId}:`).toString('base64');
      const body = new URLSearchParams({
        client_id: clientId,
        service_ticket: ticket,
        grant_type: 'https://connectapi.garmin.com/di-oauth2-service/oauth/grant/service_ticket',
        service_url: serviceUrl
      }).toString();

      const response = await axios.post(
        'https://diauth.garmin.com/di-oauth2-service/oauth/token',
        body,
        { headers: { ...headers, Authorization: `Basic ${credentials}` } }
      );

      console.log(`[Garmin] DI Bearer token obtained with client ID: ${clientId}`);
      return response.data;
    } catch (err: any) {
      const status = err.response?.status || 'no-response';
      console.warn(`[Garmin] DI exchange failed for ${clientId} (${status}): ${err.message}`);
    }
  }

  throw new Error('All DI client IDs failed. Cannot exchange ticket for Bearer token.');
}

export const finalizeLogin = async (ticket: string, ssoClient?: GarminSSOClient): Promise<void> => {
  const client = getGarminClient();
  const serviceUrl = ssoClient?.getUsedServiceUrl() || 'https://connect.garmin.com/app';

  console.log(`[Garmin] Exchanging ticket for DI Bearer token (service: ${serviceUrl})...`);
  const diToken = await exchangeTicketForDIToken(ticket, serviceUrl);

  // Build an oauth2Token object compatible with the @flow-js/garmin-connect library.
  // The library only needs access_token for Authorization headers.
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = diToken.expires_in || 3600;
  const refreshExpiresIn = diToken.refresh_token_expires_in || 7776000;

  const oauth2Token = {
    scope: diToken.scope || '',
    jti: diToken.jti || '',
    access_token: diToken.access_token,
    token_type: 'Bearer',
    refresh_token: diToken.refresh_token || '',
    expires_in: expiresIn,
    refresh_token_expires_in: refreshExpiresIn,
    expires_at: now + expiresIn,
    refresh_token_expires_at: now + refreshExpiresIn,
    last_update_date: new Date().toISOString(),
    expires_date: new Date((now + expiresIn) * 1000).toISOString()
  };

  // Inject the Bearer token directly into the library's internal client
  (client.client as any).oauth2Token = oauth2Token;

  const oauth1Token = {
    oauth_token: 'di_bearer_placeholder',
    oauth_token_secret: ''
  };
  (client.client as any).oauth1Token = oauth1Token;

  // Persist tokens to the database
  setSetting(OAUTH1_KEY, JSON.stringify(oauth1Token));
  setSetting(OAUTH2_KEY, JSON.stringify(oauth2Token));
  console.log('[Garmin] Tokens saved to database.');

  // Mark session as valid so the next /api/status poll returns immediately
  authCache = { valid: true, expiresAt: Date.now() + AUTH_TTL_SUCCESS };

  console.log('[Garmin] Login finalized. Bearer token is active.');
};
