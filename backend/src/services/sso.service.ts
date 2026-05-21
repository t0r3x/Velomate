import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';

/**
 * Direct port of the aiogarmin authentication logic to Node.js.
 * Uses the portal/api endpoints which are more modern and less restricted.
 */
export class GarminSSOClient {
  private jar: CookieJar;
  private client: any;
  private username: string = '';

  private readonly SSO_URL = 'https://sso.garmin.com';
  private readonly CLIENT_ID = 'GarminConnect';
  private readonly SERVICE_URL = 'https://connect.garmin.com/app';
  
  private readonly HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://sso.garmin.com',
    'Referer': `https://sso.garmin.com/portal/sso/en-US/sign-in?clientId=${this.CLIENT_ID}&service=${encodeURIComponent(this.SERVICE_URL)}`
  };

  constructor() {
    this.jar = new CookieJar();
    this.client = wrapper(axios.create({
      jar: this.jar,
      withCredentials: true,
      headers: this.HEADERS
    }));
  }

  async initiate(username: string, password: string) {
    this.username = username;
    console.log(`[SSO] Porting aiogarmin logic: Initiating login for ${username}...`);

    try {
      // 1. Initial GET to set cookies
      await this.client.get(`${this.SSO_URL}/portal/sso/en-US/sign-in`, {
        params: {
          clientId: this.CLIENT_ID,
          service: this.SERVICE_URL
        }
      });

      // 2. POST login credentials to the JSON API
      const response = await this.client.post(`${this.SSO_URL}/portal/api/login`, 
        {
          username,
          password,
          rememberMe: true,
          captchaToken: ''
        },
        {
          params: {
            clientId: this.CLIENT_ID,
            locale: 'en-US',
            service: this.SERVICE_URL
          },
          headers: {
            ...this.HEADERS,
            'Content-Type': 'application/json'
          }
        }
      );

      const data = response.data;
      console.log(`[SSO] Login response status: ${data.responseStatus}`);

      if (data.responseStatus === 'MFA_REQUIRED') {
        console.log('[SSO] MFA detected (aiogarmin style).');
        return { mfaRequired: true };
      }

      if (data.responseStatus === 'SUCCESS' && data.serviceTicketId) {
        console.log('[SSO] Login SUCCESS. Ticket obtained.');
        return { success: true, ticket: data.serviceTicketId };
      }

      throw new Error(data.message || 'Authentication failed.');
    } catch (error: any) {
      if (error.response && error.response.status === 403) {
        console.error('[SSO] Cloudflare block (403) even with aiogarmin logic.');
      }
      throw error;
    }
  }

  async verify(code: string) {
    console.log(`[SSO] Verifying MFA code ${code} using Portal API...`);
    
    try {
      const response = await this.client.post(`${this.SSO_URL}/portal/api/mfa/verifyCode`,
        {
          mfaMethod: 'email', // Defaulting to email as per aiogarmin
          mfaVerificationCode: code,
          rememberMyBrowser: true
        },
        {
          params: {
            clientId: this.CLIENT_ID,
            service: this.SERVICE_URL
          },
          headers: {
            ...this.HEADERS,
            'Content-Type': 'application/json'
          }
        }
      );

      const data = response.data;
      if (data.responseStatus === 'SUCCESS' && data.serviceTicketId) {
        console.log('[SSO] MFA verification SUCCESS.');
        return { success: true, ticket: data.serviceTicketId };
      }

      throw new Error(data.message || 'MFA verification failed.');
    } catch (error: any) {
      throw error;
    }
  }

  getCookies() {
    const json = this.jar.toJSON();
    return (json && json.cookies) ? json.cookies : [];
  }

  /**
   * Optional: Implementation of the DI OAuth2 exchange if the library needs it.
   * aiogarmin uses this to get the final Bearer token.
   */
  async exchangeTicket(ticket: string) {
    const DI_CLIENT_ID = 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2';
    const auth = Buffer.from(`${DI_CLIENT_ID}:`).toString('base64');

    const response = await axios.post('https://diauth.garmin.com/di-oauth2-service/oauth/token', 
      new URLSearchParams({
        client_id: DI_CLIENT_ID,
        service_ticket: ticket,
        grant_type: 'https://connectapi.garmin.com/di-oauth2-service/oauth/grant/service_ticket',
        service_url: this.SERVICE_URL
      }),
      {
        headers: {
          'User-Agent': 'GCM-Android-5.23',
          'X-Garmin-User-Agent': 'com.garmin.android.apps.connectmobile/5.23; ; Google/sdk_gphone64_arm64/google; Android/33; Dalvik/2.1.0',
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    return response.data; // access_token, refresh_token, etc.
  }
}
