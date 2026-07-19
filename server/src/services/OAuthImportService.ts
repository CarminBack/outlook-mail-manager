import crypto from 'crypto';
import { fetch } from 'undici';
import { config } from '../config';
import { AccountModel } from '../models/Account';

const MICROSOFT_TENANT = 'consumers';
const MICROSOFT_SCOPE = [
  'offline_access',
  'openid',
  'profile',
  'email',
  'https://graph.microsoft.com/User.Read',
  'https://graph.microsoft.com/Mail.Read',
].join(' ');

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
  message?: string;
}

interface OAuthSession {
  id: string;
  email: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresAt: number;
  intervalSeconds: number;
  nextPollAt: number;
  status: 'pending' | 'complete' | 'failed';
  imported?: number;
  skipped?: number;
  error?: string;
}

export interface OAuthImportStartResult {
  sessionId: string;
  email: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresAt: string;
  intervalSeconds: number;
}

export interface OAuthImportStatusResult {
  email: string;
  status: 'pending' | 'complete' | 'failed';
  imported?: number;
  skipped?: number;
  error?: string;
  retryAfterSeconds?: number;
}

type FetchLike = typeof fetch;
type ImportAccount = (email: string, clientId: string, refreshToken: string) => { imported: number; skipped: number };

function httpError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

export class OAuthImportService {
  private readonly sessions = new Map<string, OAuthSession>();
  private readonly clientId: string;
  private readonly fetchImpl: FetchLike;
  private readonly importAccount: ImportAccount;

  constructor(options: { clientId?: string; fetchImpl?: FetchLike; importAccount?: ImportAccount } = {}) {
    this.clientId = options.clientId ?? config.microsoftClientId;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.importAccount = options.importAccount ?? ((email, clientId, refreshToken) => {
      const model = new AccountModel();
      const result = model.import({
        content: `${email}----${clientId}----${refreshToken}`,
        separator: '----',
        format: ['email', 'client_id', 'refresh_token'],
      });
      return { imported: result.imported, skipped: result.skipped };
    });
  }

  async start(email: string): Promise<OAuthImportStartResult> {
    if (!this.clientId) throw httpError('服务器未配置 MICROSOFT_CLIENT_ID', 503);
    this.cleanupExpiredSessions();

    const normalizedEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      throw httpError('邮箱格式无效', 400);
    }

    const response = await this.postForm(
      `https://login.microsoftonline.com/${MICROSOFT_TENANT}/oauth2/v2.0/devicecode`,
      { client_id: this.clientId, scope: MICROSOFT_SCOPE },
    );
    const data = await response.json() as DeviceCodeResponse & { error?: string; error_description?: string };
    if (!response.ok || !data.device_code) {
      throw httpError(data.error_description || data.error || `设备授权初始化失败：HTTP ${response.status}`, 502);
    }

    const id = crypto.randomUUID();
    const intervalSeconds = Math.max(Number(data.interval || 5), 1);
    const session: OAuthSession = {
      id,
      email: normalizedEmail,
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      verificationUriComplete: data.verification_uri_complete || data.verification_uri,
      expiresAt: Date.now() + Number(data.expires_in || 900) * 1000,
      intervalSeconds,
      nextPollAt: Date.now(),
      status: 'pending',
    };
    this.sessions.set(id, session);

    return {
      sessionId: id,
      email: session.email,
      userCode: session.userCode,
      verificationUri: session.verificationUri,
      verificationUriComplete: session.verificationUriComplete,
      expiresAt: new Date(session.expiresAt).toISOString(),
      intervalSeconds,
    };
  }

  async poll(sessionId: string): Promise<OAuthImportStatusResult> {
    const session = this.sessions.get(sessionId);
    if (!session) throw httpError('授权会话不存在或已过期，请重新开始', 404);

    if (session.status !== 'pending') return this.publicStatus(session);
    if (Date.now() >= session.expiresAt) {
      session.status = 'failed';
      session.error = '微软授权已超时，请重新开始';
      return this.publicStatus(session);
    }

    if (Date.now() < session.nextPollAt) {
      return {
        ...this.publicStatus(session),
        retryAfterSeconds: Math.max(Math.ceil((session.nextPollAt - Date.now()) / 1000), 1),
      };
    }

    session.nextPollAt = Date.now() + session.intervalSeconds * 1000;
    const response = await this.postForm(
      `https://login.microsoftonline.com/${MICROSOFT_TENANT}/oauth2/v2.0/token`,
      {
        client_id: this.clientId,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: session.deviceCode,
      },
    );
    const data = await response.json() as Record<string, any>;

    if (!response.ok) {
      if (data.error === 'authorization_pending') {
        session.nextPollAt = Date.now() + session.intervalSeconds * 1000;
        return { ...this.publicStatus(session), retryAfterSeconds: session.intervalSeconds };
      }
      if (data.error === 'slow_down') {
        session.intervalSeconds += 5;
        session.nextPollAt = Date.now() + session.intervalSeconds * 1000;
        return { ...this.publicStatus(session), retryAfterSeconds: session.intervalSeconds };
      }
      session.status = 'failed';
      session.error = data.error_description || data.error || `微软授权失败：HTTP ${response.status}`;
      return this.publicStatus(session);
    }

    try {
      if (!data.refresh_token || !data.access_token) {
        throw new Error('微软未返回 refresh token，请确认应用已启用 offline_access 权限');
      }

      const identities = await this.getMicrosoftIdentities(data.access_token);
      if (!identities.includes(session.email)) {
        throw new Error(`授权账户不匹配：目标 ${session.email}，实际 ${identities.join(', ') || '未知'}`);
      }

      const result = this.importAccount(session.email, this.clientId, data.refresh_token);
      session.status = 'complete';
      session.imported = result.imported;
      session.skipped = result.skipped;
    } catch (error: any) {
      session.status = 'failed';
      session.error = error.message || '导入失败';
    } finally {
      session.deviceCode = '';
    }

    return this.publicStatus(session);
  }

  private async postForm(url: string, values: Record<string, string>) {
    return this.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(values).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  }

  private async getMicrosoftIdentities(accessToken: string): Promise<string[]> {
    const response = await this.fetchImpl(
      'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,otherMails',
      { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) },
    );
    const data = await response.json() as Record<string, any>;
    if (!response.ok) {
      throw new Error(data.error?.message || `读取微软账户信息失败：HTTP ${response.status}`);
    }

    return [data.mail, data.userPrincipalName, ...(data.otherMails || [])]
      .filter(Boolean)
      .map(value => String(value).toLowerCase());
  }

  private publicStatus(session: OAuthSession): OAuthImportStatusResult {
    return {
      email: session.email,
      status: session.status,
      imported: session.imported,
      skipped: session.skipped,
      error: session.error,
    };
  }

  private cleanupExpiredSessions() {
    const retentionMs = 10 * 60 * 1000;
    for (const [id, session] of this.sessions) {
      if (Date.now() > session.expiresAt + retentionMs) this.sessions.delete(id);
    }
  }
}
