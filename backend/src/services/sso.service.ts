import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import * as cheerio from 'cheerio';

/**
 * Custom Garmin SSO Client that mimics the Mobile App flow used by aiogarmin/garth.
 * This flow is typically less restricted by Cloudflare than the web flow.
 */
export class GarminSSOClient {
  private jar: CookieJar;
  private client: any;
  private username: string = '';

  private readonly USER_AGENT = 'com.garmin.android.apps.connectmobile';
  private readonly SSO_URL = 'https://sso.garmin.com/sso/signin';

  constructor() {
    this.jar = new CookieJar();
    this.client = wrapper(axios.create({
      jar: this.jar,
      withCredentials: true,
      headers: {
        'User-Agent': this.USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US',
      }
    }));
  }

  async initiate(username: string, password: string) {
    this.username = username;
    console.log(`[SSO] Starting Mobile SSO flow for ${username}...`);

    const params = {
      service: 'https://connect.garmin.com/modern/',
      webhost: 'https://connect.garmin.com/modern/',
      source: 'https://connect.garmin.com/modern/',
      redirectAfterAccountLoginUrl: 'https://connect.garmin.com/modern/',
      redirectAfterAccountCreationUrl: 'https://connect.garmin.com/modern/',
      gsp: 'true',
      maxWidth: '476',
      showLoginForm: 'true',
      generateExtraServiceTicket: 'true',
      use_idp: 'true',
      idp_term: 'https://connect.garmin.com/modern/',
      inline: 'true',
      gss: '1',
      entityId: 'garmin_connect',
      clientId: 'GARMIN_CONNECT',
      rememberMe: 'true'
    };

    // 1. Initial GET to establish session and get CSRF
    const response1 = await this.client.get(this.SSO_URL, { params });
    const $ = cheerio.load(response1.data);
    const csrf = $('input[name="_csrf"]').val() as string;

    if (!csrf) {
      throw new Error('Failed to obtain CSRF token from Garmin SSO.');
    }

    // 2. POST credentials
    const response2 = await this.client.post(this.SSO_URL, new URLSearchParams({
      username,
      password,
      embed: 'true',
      _csrf: csrf,
      rememberme: 'on'
    }), {
      params,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': `${this.SSO_URL}?${new URLSearchParams(params).toString()}`
      }
    });

    // Check for MFA
    if (response2.data.includes('mfa-code') || response2.data.includes('loginEnterMfaCode')) {
      console.log('[SSO] MFA Required.');
      return { mfaRequired: true };
    }

    // Check for Ticket
    const ticketMatch = response2.data.match(/ticket=([^"']+)/);
    if (ticketMatch) {
      return { success: true, ticket: ticketMatch[1] };
    }

    // Check for errors
    if (response2.data.includes('error-message')) {
      const errorMsg = cheerio.load(response2.data)('.error-message').text().trim();
      throw new Error(errorMsg || 'Invalid credentials.');
    }

    throw new Error('Unexpected SSO response structure.');
  }

  async verify(code: string) {
    console.log(`[SSO] Verifying MFA code ${code}...`);
    const mfaUrl = 'https://sso.garmin.com/sso/verifyMFA/loginEnterMfaCode';
    
    const params = {
      service: 'https://connect.garmin.com/modern/',
      rememberMe: 'true'
    };

    // 1. GET MFA page for CSRF
    const mfaPage = await this.client.get(mfaUrl, { params });
    const $ = cheerio.load(mfaPage.data);
    const csrf = $('input[name="_csrf"]').val() as string;

    // 2. POST MFA code
    const response = await this.client.post(mfaUrl, new URLSearchParams({
      'mfa-code': code,
      'embed': 'true',
      '_csrf': csrf,
      'fromSubmit': 'true',
      'rememberme': 'on'
    }), {
      params,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': mfaUrl
      }
    });

    const ticketMatch = response.data.match(/ticket=([^"']+)/);
    if (ticketMatch) {
      return { success: true, ticket: ticketMatch[1] };
    }

    throw new Error('MFA verification failed. Please check the code.');
  }
}
