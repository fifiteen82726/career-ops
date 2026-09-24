import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { startServer } from '../serve.mjs';

const job = (company, contacts, overrides = {}) => ({ scanDate: '2026-09-15', scannedAt: '2026-09-16T15:00:00.000Z', scannedAtPrecision: 'receipt', priority: 'priority', priorityLabel: '優先投遞', score: 90, recommendation: '投遞', recommendationUrl: 'https://apply.example/data-engineer', company, title: 'Data Engineer', category: 'Data', location: 'NYC', workMode: 'Hybrid', postedDate: '2026-09-15', primaryGap: 'None', resume: 'Data Engineer', applyUrl: 'https://apply.example/data-engineer', linkedinPeopleUrl: '', referralMessage: '', referralContacts: contacts, ...overrides });

test('browser referral filter, synchronized Connections search, message editing, and copy controls work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sunny-ui-')); mkdirSync(join(root, 'data')); for (const file of ['index.html', 'app.js', 'scan-status.js', 'styles.css']) cpSync(join('local/sunny-job-search', file), join(root, file));
  const contact = { fullName: 'Example Person', profileUrl: 'https://www.linkedin.com/in/example/', currentEmployer: 'Matched Co', currentTitle: 'Data Engineer', connectedLabelRaw: 'Connected yesterday', connectedAtEarliest: '2026-09-15', connectedAtLatest: '2026-09-15' };
  writeFileSync(join(root, 'data/jobs.json'), JSON.stringify({ schemaVersion: 1, timeZone: 'America/New_York', referralDataStatus: 'partial', referralDataUpdatedAt: '2026-09-16T00:00:00Z', jobs: [
    job('Matched Co', [contact]),
    job('Matched Co', [contact], { scanDate: '2026-09-14', priority: 'suggested', priorityLabel: '建議投遞', score: 84, title: 'Analytics Engineer', applyUrl: 'https://apply.example/analytics-engineer', recommendationUrl: 'https://apply.example/analytics-engineer' }),
    job('Unmatched Co', [], { applyUrl: 'https://apply.example/unmatched', recommendationUrl: 'https://apply.example/unmatched' }),
  ] }));
  writeFileSync(join(root, 'data/scan-status.json'), JSON.stringify({ schemaVersion: 1, days: [
    { date: '2026-09-16', status: 'yellow', label: '有問題', summary: '來源警告', issues: ['1 個來源警告'], scannedPortals: 1, found: 2, published: 0, normalPending: 0, candidateExceptions: 0, sourceExceptions: 1 },
    { date: '2026-09-15', status: 'red', label: '重大錯誤', summary: '缺少收據', issues: ['已宣告掃描但找不到可用收據'], scannedPortals: 0, found: 0, published: 0, normalPending: 0, candidateExceptions: 0, sourceExceptions: 0 },
  ] }));
  const server = startServer({ root, port: 0 }); await new Promise(resolve => server.once('listening', resolve)); const port = server.address().port; let browser;
  try {
    const headers = await new Promise((resolve, reject) => httpRequest({ host: '127.0.0.1', port, path: '/' }, response => { const headers = response.headers; response.resume(); response.on('end', () => resolve(headers)); }).on('error', reject).end());
    assert.equal(headers['referrer-policy'], 'no-referrer'); assert.equal(headers['cache-control'], 'no-store');
    browser = await chromium.launch({ headless: true }); const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] }); const page = await context.newPage(); await page.clock.setFixedTime(new Date('2026-09-16T16:00:00.000Z')); await page.goto(`http://127.0.0.1:${port}/`);
    await page.locator('.results tbody tr').first().waitFor(); assert.equal(await page.locator('.results tbody tr').count(), 3); await page.locator('#scan-status tbody tr').first().waitFor(); const statusDot = page.locator('.status-dot.yellow'); await statusDot.focus(); assert.equal(await statusDot.getAttribute('aria-describedby'), 'scan-status-detail-0'); assert.equal(await page.locator('#scan-status-detail-0').isVisible(), true); assert.equal(await page.locator('#scan-status-detail-0').evaluate(el => el.parentElement === document.body), true); const lastStatusDot = page.locator('#scan-status .status-dot').last(); await lastStatusDot.focus(); assert.equal(await page.locator('#scan-status-detail-1').isVisible(), true); assert.equal(await page.locator('#scan-status-detail-1').evaluate(el => el.parentElement === document.body), true); await lastStatusDot.hover(); assert.equal(await page.locator('#scan-status-detail-1').isVisible(), true); await page.locator('#referrals-only').check(); assert.equal(await page.locator('.results tbody tr').count(), 2);
    const link = page.locator('.referral-contact a').first(); assert.equal(await link.getAttribute('href'), 'https://www.linkedin.com/in/example/'); assert.equal(await link.getAttribute('referrerpolicy'), 'no-referrer');
    await page.getByRole('button', { name: '複製姓名' }).first().click(); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Example Person'); await page.getByRole('button', { name: '複製連結' }).first().click(); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'https://www.linkedin.com/in/example/');

    await page.locator('#referrals-only').uncheck(); await page.locator('#query').fill('Example Person'); assert.equal(await page.locator('.results tbody tr').count(), 2); assert.equal(await page.locator('.connection-card').count(), 1); assert.equal(await page.locator('.connection-job').count(), 2);
    await page.locator('#query').fill('Analytics Engineer'); assert.equal(await page.locator('.results tbody tr').count(), 1); assert.equal(await page.locator('.connection-job').count(), 1);
    await page.locator('#query').fill('');

    const checkboxes = page.locator('.connection-job input[type="checkbox"]'); assert.equal(await checkboxes.count(), 2); await checkboxes.nth(0).check(); await checkboxes.nth(1).check();
    await page.locator('#query').fill('Analytics Engineer'); assert.equal(await page.locator('.connection-job input[type="checkbox"]:checked').count(), 1);
    await page.locator('#query').fill(''); assert.equal(await page.locator('.connection-job input[type="checkbox"]:checked').count(), 1);
    await checkboxes.nth(0).check(); await page.getByRole('button', { name: '產生內推訊息' }).click();
    const dialog = page.getByRole('dialog', { name: '編輯內推訊息' }); await dialog.waitFor(); const message = dialog.locator('textarea');
    assert.match(await message.inputValue(), /following positions at Matched Co/); assert.match(await message.inputValue(), /Data Engineer/); assert.match(await message.inputValue(), /Analytics Engineer/); assert.match(await message.inputValue(), /Email: yiyunliao21@gmail\.com/);
    await message.fill('Edited referral message'); await dialog.getByRole('button', { name: '複製訊息' }).click(); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Edited referral message'); await dialog.getByRole('button', { name: '關閉' }).click();

    await page.locator('#query').fill('Unmatched Co'); assert.equal(await page.locator('.connection-card').count(), 0); assert.equal(await page.locator('#connections-empty').isVisible(), true); assert.match(await page.locator('#referral-status').innerText(), /內推資料/);
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
