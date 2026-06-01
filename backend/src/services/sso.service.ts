import { CookieJar } from 'tough-cookie';
import logger from '../logger';

/**
 * Garmin SSO Client using TLS Impersonation (got-scraping / curl_cffi equivalent).
 * Strategy chain (mirrors ha-garmin Python library):
 *   1. Mobile iOS endpoint (primary, no anti-WAF delay)
 *   2. Portal web endpoint (fallback, 5-10s anti-WAF delay)
 *
 * After getting a serviceTicketId, use finalizeLoginWithDIToken() in garmin.service.ts
 * instead of the @flow-js library's OAuth1/OAuth2 exchange (which is incompatible
 * with tickets issued by the portal/mobile JSON API endpoints).
 */
export class GarminSSOClient {
  private jar: CookieJar;
  private gotScraping: any = null;

  private mfaMethod: string = 'email';
  private usedStrategy: 'mobile' | 'portal' = 'mobile';
  private usedServiceUrl: string = '';

  private readonly MOBILE_CLIENT_ID = 'GCM_IOS_DARK';
  private readonly MOBILE_SERVICE_URL = 'https://mobile.integration.garmin.com/gcm/ios';

  private readonly PORTAL_CLIENT_ID = 'GarminConnect';
  private readonly PORTAL_SERVICE_URL = 'https://connect.garmin.com/app';

  private readonly SSO_BASE = 'https://sso.garmin.com';

  constructor() {
    this.jar = new CookieJar();
  }

  private async ensureInitialized() {
    if (!this.gotScraping) {
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
      http2: true,
      throwHttpErrors: false
    });
  }

  private parseResponseStatus(data: any): string {
    // Portal returns: { "responseStatus": "MFA_REQUIRED" }
    // Mobile returns: { "responseStatus": { "type": "MFA_REQUIRED" } }
    if (typeof data.responseStatus === 'string') return data.responseStatus;
    if (data.responseStatus && typeof data.responseStatus === 'object') {
      return data.responseStatus.type || '';
    }
    return '';
  }

  private delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async initiate(username: string, password: string) {
    logger.info(`[SSO] Starting login for ${username}...`);

    try {
      const result = await this.tryMobileLogin(username, password);
      this.usedStrategy = 'mobile';
      this.usedServiceUrl = this.MOBILE_SERVICE_URL;
      return result;
    } catch (mobileError: any) {
      logger.warn(`[SSO] Mobile strategy failed: ${mobileError.message}. Trying portal...`);
    }

    try {
      const result = await this.tryPortalLogin(username, password);
      this.usedStrategy = 'portal';
      this.usedServiceUrl = this.PORTAL_SERVICE_URL;
      return result;
    } catch (portalError: any) {
      logger.error(`[SSO] Portal strategy failed: ${portalError.message}`);
      throw portalError;
    }
  }

  private async tryMobileLogin(username: string, password: string) {
    const client = await this.getClient();
    const serviceUrl = this.MOBILE_SERVICE_URL;
    logger.info('[SSO] Mobile strategy: establishing session...');

    const getResp = await client.get(`${this.SSO_BASE}/mobile/api/login`, {
      searchParams: { clientId: this.MOBILE_CLIENT_ID, locale: 'en-US', service: serviceUrl },
      headers: { 'User-Agent': 'GarminConnect/4 CFNetwork/1408.0.4 Darwin/22.5.0', 'Accept': 'application/json' }
    });

    if (getResp.statusCode >= 400) {
      throw new Error(`Mobile GET failed with status ${getResp.statusCode}`);
    }

    logger.info('[SSO] Mobile strategy: submitting credentials...');
    const postResp = await client.post(`${this.SSO_BASE}/mobile/api/login`, {
      json: { username, password, rememberMe: true, captchaToken: '' },
      searchParams: { clientId: this.MOBILE_CLIENT_ID, locale: 'en-US', service: serviceUrl },
      headers: {
        'User-Agent': 'GarminConnect/4 CFNetwork/1408.0.4 Darwin/22.5.0',
        'Origin': this.SSO_BASE,
        'Referer': `${this.SSO_BASE}/mobile/api/login?clientId=${this.MOBILE_CLIENT_ID}&service=${encodeURIComponent(serviceUrl)}`
      }
    });

    if (postResp.statusCode >= 400) {
      throw new Error(`Mobile POST failed with status ${postResp.statusCode}: ${String(postResp.body)}`);
    }

    return this.handleLoginResponse(postResp.body);
  }

  private async tryPortalLogin(username: string, password: string) {
    const client = await this.getClient();
    const serviceUrl = this.PORTAL_SERVICE_URL;
    logger.info('[SSO] Portal strategy: establishing session...');

    await client.get(`${this.SSO_BASE}/portal/sso/en-US/sign-in`, {
      searchParams: { clientId: this.PORTAL_CLIENT_ID, service: serviceUrl }
    });

    const delayMs = 5000 + Math.floor(Math.random() * 5000);
    logger.info(`[SSO] Portal strategy: waiting ${Math.round(delayMs / 1000)}s (anti-WAF)...`);
    await this.delay(delayMs);

    logger.info('[SSO] Portal strategy: submitting credentials...');
    const response = await client.post(`${this.SSO_BASE}/portal/api/login`, {
      json: { username, password, rememberMe: true, captchaToken: '' },
      searchParams: { clientId: this.PORTAL_CLIENT_ID, locale: 'en-US', service: serviceUrl },
      headers: {
        'Origin': this.SSO_BASE,
        'Referer': `${this.SSO_BASE}/portal/sso/en-US/sign-in?clientId=${this.PORTAL_CLIENT_ID}&service=${encodeURIComponent(serviceUrl)}`
      }
    });

    const body = String(response.body);
    if (body.includes('cloudflare') || body.includes('cf-ray') || body.includes('Just a moment')) {
      throw new Error('Cloudflare block detected. Try again later or from a different network.');
    }

    return this.handleLoginResponse(response.body);
  }

  private handleLoginResponse(rawBody: any): { mfaRequired: true } | { success: true; ticket: string } {
    let data: any;
    try {
      data = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
    } catch {
      throw new Error(`Non-JSON response from Garmin: ${String(rawBody)}`);
    }

    const status = this.parseResponseStatus(data);
    logger.info(`[SSO] Response status: ${status}`);

    if (status === 'MFA_REQUIRED') {
      const mfaInfo = data.customerMfaInfo || {};
      this.mfaMethod = mfaInfo.mfaLastMethodUsed || 'email';
      logger.info(`[SSO] MFA required, method: ${this.mfaMethod}`);
      return { mfaRequired: true };
    }

    if ((status === 'SUCCESS' || status === 'SUCCESSFUL') && data.serviceTicketId) {
      logger.info('[SSO] Login successful.');
      return { success: true, ticket: data.serviceTicketId };
    }

    const message = data.message || data.errorMessage || `Unexpected status: ${status}`;
    throw new Error(message);
  }

  async verify(code: string) {
    logger.info(`[SSO] Verifying MFA code (method: ${this.mfaMethod}, strategy: ${this.usedStrategy})...`);
    const client = await this.getClient();

    const verifyPath = this.usedStrategy === 'mobile'
      ? '/mobile/api/mfa/verifyCode'
      : '/portal/api/mfa/verifyCode';

    const clientId = this.usedStrategy === 'mobile' ? this.MOBILE_CLIENT_ID : this.PORTAL_CLIENT_ID;
    const serviceUrl = this.usedStrategy === 'mobile' ? this.MOBILE_SERVICE_URL : this.PORTAL_SERVICE_URL;

    const response = await client.post(`${this.SSO_BASE}${verifyPath}`, {
      json: {
        mfaMethod: this.mfaMethod,
        mfaVerificationCode: code,
        rememberMyBrowser: true,
        reconsentList: [],
        mfaSetup: false
      },
      searchParams: { clientId, service: serviceUrl },
      throwHttpErrors: false
    });

    let data: any;
    try {
      data = JSON.parse(response.body as string);
    } catch {
      throw new Error(`Non-JSON MFA response: ${String(response.body)}`);
    }

    const status = this.parseResponseStatus(data);
    logger.info(`[SSO] MFA response status: ${status}`);

    if ((status === 'SUCCESS' || status === 'SUCCESSFUL') && data.serviceTicketId) {
      logger.info('[SSO] MFA verified successfully.');
      return { success: true, ticket: data.serviceTicketId };
    }

    const message = data.message || data.errorMessage || `MFA failed (status: ${status})`;
    throw new Error(message);
  }

  getUsedStrategy() { return this.usedStrategy; }
  getUsedServiceUrl() { return this.usedServiceUrl; }

  async getCookies() {
    return await this.jar.getCookies(this.SSO_BASE);
  }
}
