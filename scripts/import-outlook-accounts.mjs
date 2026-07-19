#!/usr/bin/env node

import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MICROSOFT_TENANT = 'consumers';
const MICROSOFT_SCOPE = [
  'offline_access',
  'openid',
  'profile',
  'email',
  'https://graph.microsoft.com/User.Read',
  'https://graph.microsoft.com/Mail.Read',
].join(' ');
const USER_AGENT = 'Mozilla/5.0 OutlookMailManagerImporter/1.0';

export function parseAccounts(content, separator = '----') {
  const emails = [];
  const seen = new Set();

  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const email = line.split(separator, 1)[0].trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error(`第 ${index + 1} 行邮箱格式无效`);
    }
    if (!seen.has(email)) {
      seen.add(email);
      emails.push(email);
    }
  }

  if (emails.length === 0) throw new Error('文件中没有可导入的邮箱');
  return emails;
}

export function normalizeManagerUrl(value) {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

async function postForm(url, data) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
    },
    body: new URLSearchParams(data),
  });
  const json = await response.json().catch(() => ({}));
  return { response, json };
}

async function requestDeviceCode(clientId) {
  const { response, json } = await postForm(
    `https://login.microsoftonline.com/${MICROSOFT_TENANT}/oauth2/v2.0/devicecode`,
    { client_id: clientId, scope: MICROSOFT_SCOPE },
  );
  if (!response.ok) {
    throw new Error(json.error_description || json.error || `设备授权初始化失败：HTTP ${response.status}`);
  }
  return json;
}

async function pollDeviceToken(clientId, deviceCode) {
  let intervalMs = Math.max(Number(deviceCode.interval || 5), 1) * 1000;
  const deadline = Date.now() + Number(deviceCode.expires_in || 900) * 1000;

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    const { response, json } = await postForm(
      `https://login.microsoftonline.com/${MICROSOFT_TENANT}/oauth2/v2.0/token`,
      {
        client_id: clientId,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode.device_code,
      },
    );

    if (response.ok) return json;
    if (json.error === 'authorization_pending') continue;
    if (json.error === 'slow_down') {
      intervalMs += 5000;
      continue;
    }
    throw new Error(json.error_description || json.error || `微软授权失败：HTTP ${response.status}`);
  }

  throw new Error('微软授权超时，请重新执行');
}

async function getMicrosoftIdentity(accessToken) {
  const response = await fetch(
    'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,otherMails',
    { headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': USER_AGENT } },
  );
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error?.message || `读取微软账户信息失败：HTTP ${response.status}`);

  return [json.mail, json.userPrincipalName, ...(json.otherMails || [])]
    .filter(Boolean)
    .map(value => String(value).toLowerCase());
}

function openBrowser(url) {
  const command = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];

  const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

async function managerRequest(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      ...(options.headers || {}),
    },
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.code !== 200) {
    throw new Error(json.message || `邮箱管理器请求失败：HTTP ${response.status}`);
  }
  return json.data;
}

async function loginManager(baseUrl, username, password) {
  const data = await managerRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  return data.token || '';
}

async function importAccount(baseUrl, authToken, email, clientId, refreshToken) {
  return managerRequest(baseUrl, '/api/accounts/import', {
    method: 'POST',
    headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
    body: JSON.stringify({
      content: `${email}----${clientId}----${refreshToken}`,
      separator: '----',
      format: ['email', 'client_id', 'refresh_token'],
    }),
  });
}

function usage() {
  console.log(`用法：
  MICROSOFT_CLIENT_ID=... \\
  OUTLOOK_MANAGER_USERNAME=... \\
  OUTLOOK_MANAGER_PASSWORD=... \\
  node scripts/import-outlook-accounts.mjs <账号文件> [分隔符]

账号文件默认每行格式：
  email@outlook.com----password

说明：密码字段只为兼容现有账号文件，脚本不会使用、上传、打印或另行保存邮箱密码。
每个邮箱仍需在微软官方页面完成一次授权。`);
}

async function main() {
  const [inputPath, separator = '----'] = process.argv.slice(2);
  if (!inputPath || process.argv.includes('--help') || process.argv.includes('-h')) {
    usage();
    process.exitCode = inputPath ? 0 : 1;
    return;
  }

  const clientId = process.env.MICROSOFT_CLIENT_ID?.trim();
  const managerUrl = normalizeManagerUrl(process.env.OUTLOOK_MANAGER_URL || 'https://outlook.mewinyou.shop');
  const managerUsername = process.env.OUTLOOK_MANAGER_USERNAME || '';
  const managerPassword = process.env.OUTLOOK_MANAGER_PASSWORD || '';

  if (!clientId) throw new Error('缺少 MICROSOFT_CLIENT_ID');
  if (!managerPassword) throw new Error('缺少 OUTLOOK_MANAGER_PASSWORD');

  const emails = parseAccounts(await fs.readFile(inputPath, 'utf8'), separator);
  console.log(`发现 ${emails.length} 个邮箱。邮箱密码不会被使用或上传。`);

  const authToken = await loginManager(managerUrl, managerUsername, managerPassword);
  console.log(`已登录邮箱管理器：${managerUrl}`);

  let imported = 0;
  let skipped = 0;
  const failed = [];

  for (const [index, email] of emails.entries()) {
    console.log(`\n[${index + 1}/${emails.length}] 请授权：${email}`);
    try {
      const deviceCode = await requestDeviceCode(clientId);
      const verificationUrl = deviceCode.verification_uri_complete || deviceCode.verification_uri;
      console.log(deviceCode.message || `打开 ${deviceCode.verification_uri} 并输入代码 ${deviceCode.user_code}`);
      openBrowser(verificationUrl);

      const token = await pollDeviceToken(clientId, deviceCode);
      if (!token.refresh_token) throw new Error('微软未返回 refresh_token，请确认已申请 offline_access 权限');

      const identities = await getMicrosoftIdentity(token.access_token);
      if (!identities.includes(email)) {
        throw new Error(`授权账户不匹配：目标 ${email}，实际 ${identities.join(', ') || '未知'}`);
      }

      const result = await importAccount(managerUrl, authToken, email, clientId, token.refresh_token);
      imported += result.imported || 0;
      skipped += result.skipped || 0;
      console.log(`完成：新增 ${result.imported || 0}，跳过 ${result.skipped || 0}`);
    } catch (error) {
      failed.push({ email, message: error.message });
      console.error(`失败：${error.message}`);
    }
  }

  console.log(`\n处理完成：新增 ${imported}，跳过 ${skipped}，失败 ${failed.length}`);
  for (const item of failed) console.log(`- ${item.email}: ${item.message}`);
  if (failed.length > 0) process.exitCode = 2;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch(error => {
    console.error(`错误：${error.message}`);
    process.exitCode = 1;
  });
}
