import { GarminConnect } from '@flow-js/garmin-connect';
import path from 'path';
import fs from 'fs';
import { GarminSSOClient } from './sso.service';
import { CookieJar } from 'tough-cookie';

const sessionDir = path.join(__dirname, '../../session');

// Ensure session directory exists
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
  const tokenFiles = ['oauth1_token.json', 'oauth2_token.json', 'user_settings.json'];
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

  if (!user || !pass) {
    throw new Error('Username and password are required.');
  }

  console.log(`Attempting login for user: ${user}`);
  await client.login(user, pass);
  client.exportTokenToFile(sessionDir);
  console.log('Login successful.');
};

export const finalizeLogin = async (ticket: string, ssoClient?: GarminSSOClient): Promise<void> => {
  const client = getGarminClient();
  
  console.log('Finalizing login with ticket...');
  
  if (ssoClient) {
    const cookies = ssoClient.getCookies();
    const jar = (client.client as any).client.defaults.jar as CookieJar;
    
    if (jar && Array.isArray(cookies)) {
      console.log(`Syncing ${cookies.length} session cookies to library client...`);
      for (const cookieData of cookies) {
        try {
          const cookieStr = `${cookieData.key}=${cookieData.value}; Domain=${cookieData.domain}; Path=${cookieData.path}`;
          await jar.setCookie(cookieStr, 'https://sso.garmin.com');
          await jar.setCookie(cookieStr, 'https://connect.garmin.com');
        } catch (e) {
          // Ignore individual cookie errors
        }
      }
    }
  }

  // 1. Fetch OAuth Consumer info
  await client.client.fetchOauthConsumer();
  
  // 2. Exchange ticket for OAuth1 token
  const oauth1 = await client.client.getOauth1Token(ticket);
  
  // 3. Exchange OAuth1 for OAuth2 and establish session
  await client.client.exchange(oauth1);
  
  // 4. Save tokens to file for future use
  client.exportTokenToFile(sessionDir);
  console.log('Login finalized and tokens saved.');
};

