import { CookieJar } from 'tough-cookie';

/**
 * Advanced Garmin SSO Client that uses TLS Impersonation (like aiogarmin's curl_cffi).
 * This is the only way to bypass Cloudflare's modern "Just a moment" challenges.
 */
export class GarminSSOClient {
  private jar: CookieJar;
  private username: string = '';
  private gotScraping: any = null;

  private readonly SSO_URL = 'https://sso.garmin.com';
  private readonly CLIENT_ID = 'GarminConnect';
  private readonly SERVICE_URL = 'https://connect.garmin.com/app';

  constructor() {
    this.jar = new CookieJar();
  }

  private async ensureInitialized() {
    if (!this.gotScraping) {
      // Dynamic import because got-scraping is ESM only
      const { gotScraping } = await import('got-scraping');
      this.gotScraping = gotScraping;
    }
  }

  private async getClient() {
    await this.ensureInitialized();
    return this.gotScraping.extend({
      cookieJar: this.jar,
      headerGeneratorOptions: {
        browsers: [{ name: 'chrome', minVersion: 110 }],
        devices: ['desktop'],
        operatingSystems: ['windows']
      },
      http2: true
    });
  }

  async initiate(username: string, password: string) {
    this.username = username;
    console.log(`[SSO] Using TLS Impersonation (got-scraping) for ${username}...`);
    const client = await this.getClient();

    try {
      // 1. Initial GET to establish session and get cookies
      console.log('[SSO] Step 1: Establishing session...');
      await client.get(`${this.SSO_URL}/portal/sso/en-US/sign-in`, {
        searchParams: {
          clientId: this.CLIENT_ID,
          service: this.SERVICE_URL
        }
      });

      // 2. POST login credentials (JSON API)
      console.log('[SSO] Step 2: Submitting credentials to JSON API...');
      const response = await client.post(`${this.SSO_URL}/portal/api/login`, {
        json: {
          username,
          password,
          rememberMe: true,
          captchaToken: ''
        },
        searchParams: {
          clientId: this.CLIENT_ID,
          locale: 'en-US',
          service: this.SERVICE_URL
        },
        headers: {
          'Origin': 'https://sso.garmin.com',
          'Referer': `https://sso.garmin.com/portal/sso/en-US/sign-in?clientId=${this.CLIENT_ID}&service=${encodeURIComponent(this.SERVICE_URL)}`
        }
      });

      const data: any = JSON.parse(response.body);
      console.log(`[SSO] Response Status: ${data.responseStatus}`);

      if (data.responseStatus === 'MFA_REQUIRED') {
        console.log('[SSO] MFA Challenge detected.');
        return { mfaRequired: true };
      }

      if (data.responseStatus === 'SUCCESS' && data.serviceTicketId) {
        console.log('[SSO] Login SUCCESS.');
        return { success: true, ticket: data.serviceTicketId };
      }

      throw new Error(data.message || 'Login failed.');
    } catch (error: any) {
      console.error(`[SSO] Error: ${error.message}`);
      if (error.response) {
        console.error(`[SSO] Response Code: ${error.response.statusCode}`);
        if (error.response.body.includes('cloudflare')) {
          console.error('[SSO] Still being blocked by Cloudflare. They are checking JS execution.');
        }
      }
      throw error;
    }
  }

  async verify(code: string) {
    console.log(`[SSO] Verifying MFA code ${code}...`);
    const client = await this.getClient();
    
    try {
      const response = await client.post(`${this.SSO_URL}/portal/api/mfa/verifyCode`, {
        json: {
          mfaMethod: 'email',
          mfaVerificationCode: code,
          rememberMyBrowser: true
        },
        searchParams: {
          clientId: this.CLIENT_ID,
          service: this.SERVICE_URL
        }
      });

      const data: any = JSON.parse(response.body);
      if (data.responseStatus === 'SUCCESS' && data.serviceTicketId) {
        console.log('[SSO] MFA Verified.');
        return { success: true, ticket: data.serviceTicketId };
      }

      throw new Error(data.message || 'MFA verification failed.');
    } catch (error: any) {
      throw error;
    }
  }

  async getCookies() {
    return await this.jar.getCookies(this.SSO_URL);
  }
}
