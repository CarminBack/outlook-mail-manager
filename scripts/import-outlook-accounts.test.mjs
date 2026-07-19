import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeManagerUrl, parseAccounts } from './import-outlook-accounts.mjs';

test('parseAccounts accepts email-password lines without retaining passwords', () => {
  assert.deepEqual(
    parseAccounts('One@outlook.com----secret\n# comment\none@outlook.com----other\ntwo@hotmail.com----pass'),
    ['one@outlook.com', 'two@hotmail.com'],
  );
});

test('parseAccounts supports a custom separator', () => {
  assert.deepEqual(parseAccounts('user@outlook.com|secret', '|'), ['user@outlook.com']);
});

test('parseAccounts rejects invalid email rows without exposing the row content', () => {
  assert.throws(() => parseAccounts('not-an-email----secret'), /第 1 行邮箱格式无效/);
});

test('normalizeManagerUrl removes trailing slash and URL extras', () => {
  assert.equal(normalizeManagerUrl('https://outlook.mewinyou.shop/?x=1#top'), 'https://outlook.mewinyou.shop');
});
