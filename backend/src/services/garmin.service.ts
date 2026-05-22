import { GarminConnect } from '@flow-js/garmin-connect';
import axios from 'axios';
import path from 'path';
import fs from 'fs';
import { GarminSSOClient } from './sso.service';

const sessionDir = path.join(__dirname, '../../session');

if (!fs.existsSync(sessionDir)) {
  fs.mkdirSync(sessionDir, { recursive: true });
}

let gcClient: GarminConnect | null = null;

export const getGarminClient = (): GarminConnect => {
  if (!gcClient) {
    const username = process.env.GARMIN_USERNAME || 'placeholder@example.com';
    const password = process.env.GARMIN_PASSWORD || 'placeholder';
    gcClient = new GarminConnect({ username, password });
  }
  return gcClient;
};

export const hasCachedSession = (): boolean => {
  const tokenFiles = ['oauth1_token.json', 'oauth2_token.json'];
  return tokenFiles.every(file => fs.existsSync(path.join(sessionDir, file)));
};

export const trySessionAuth = async (): Promise<boolean> => {
  const client = getGarminClient();
  try {
    if (hasCachedSession()) {
      client.loadTokenByFile(sessionDir);
      await client.getUserSettings();
      console.log('Successfully authenticated using cached tokens.');
      return true;
    }
  } catch (error) {
    console.warn('Cached session is invalid or expired.');
  }
  return false;
};

export const loginGarmin = async (username?: string, password?: string): Promise<void> => {
  const client = getGarminClient();
  const user = username || process.env.GARMIN_USERNAME;
  const pass = password || process.env.GARMIN_PASSWORD;

  if (!user || !pass) throw new Error('Username and password are required.');

  console.log(`Attempting login for user: ${user}`);
  await client.login(user, pass);
  client.exportTokenToFile(sessionDir);
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

  // oauth1Token is required by exportTokenToFile — use a sentinel value
  (client.client as any).oauth1Token = {
    oauth_token: 'di_bearer_placeholder',
    oauth_token_secret: ''
  };

  console.log('[Garmin] Saving tokens to disk...');
  client.exportTokenToFile(sessionDir);
  console.log('[Garmin] Login finalized. Bearer token is active.');
};
