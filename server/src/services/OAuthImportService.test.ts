import test from 'node:test';
import assert from 'node:assert/strict';
import { Response, fetch } from 'undici';
import { OAuthImportService } from './OAuthImportService';

function mockFetch(responses: Array<{ status?: number; body: Record<string, any> }>): typeof fetch {
  return (async () => {
    const response = responses.shift();
    if (!response) throw new Error('Unexpected fetch call');
    return new Response(JSON.stringify(response.body), {
      status: response.status || 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

const deviceCode = {
  device_code: 'device-secret',
  user_code: 'ABCD-EFGH',
  verification_uri: 'https://microsoft.com/devicelogin',
  verification_uri_complete: 'https://microsoft.com/devicelogin?otc=ABCD-EFGH',
  expires_in: 900,
  interval: 1,
};

test('starts a device authorization without exposing the device code', async () => {
  const service = new OAuthImportService({
    clientId: 'client-id',
    fetchImpl: mockFetch([{ body: deviceCode }]),
  });

  const result = await service.start('USER@outlook.com');
  assert.equal(result.email, 'user@outlook.com');
  assert.equal(result.userCode, 'ABCD-EFGH');
  assert.equal('deviceCode' in result, false);
});

test('imports a refresh token only when the Microsoft identity matches', async () => {
  let imported: string[] = [];
  const service = new OAuthImportService({
    clientId: 'client-id',
    fetchImpl: mockFetch([
      { body: deviceCode },
      { body: { access_token: 'access-secret', refresh_token: 'refresh-secret' } },
      { body: { mail: 'user@outlook.com', userPrincipalName: 'user@outlook.com', otherMails: [] } },
    ]),
    importAccount: (email, clientId, refreshToken) => {
      imported = [email, clientId, refreshToken];
      return { imported: 1, skipped: 0 };
    },
  });

  const started = await service.start('user@outlook.com');
  const result = await service.poll(started.sessionId);

  assert.equal(result.status, 'complete');
  assert.deepEqual(imported, ['user@outlook.com', 'client-id', 'refresh-secret']);
});

test('rejects an authorization completed with a different Microsoft account', async () => {
  let importCalled = false;
  const service = new OAuthImportService({
    clientId: 'client-id',
    fetchImpl: mockFetch([
      { body: deviceCode },
      { body: { access_token: 'access-secret', refresh_token: 'refresh-secret' } },
      { body: { mail: 'other@outlook.com', userPrincipalName: 'other@outlook.com', otherMails: [] } },
    ]),
    importAccount: () => {
      importCalled = true;
      return { imported: 1, skipped: 0 };
    },
  });

  const started = await service.start('user@outlook.com');
  const result = await service.poll(started.sessionId);

  assert.equal(result.status, 'failed');
  assert.match(result.error || '', /授权账户不匹配/);
  assert.equal(importCalled, false);
});

test('keeps the session pending while Microsoft authorization is incomplete', async () => {
  const service = new OAuthImportService({
    clientId: 'client-id',
    fetchImpl: mockFetch([
      { body: deviceCode },
      { status: 400, body: { error: 'authorization_pending' } },
    ]),
  });

  const started = await service.start('user@outlook.com');
  const result = await service.poll(started.sessionId);

  assert.equal(result.status, 'pending');
  assert.equal(result.retryAfterSeconds, 1);
});
