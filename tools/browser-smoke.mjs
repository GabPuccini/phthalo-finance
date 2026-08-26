/**
 * browser-smoke.mjs
 *
 * Drives the real app in a real browser and walks the manual test list.
 *
 * This is a development tool, not part of the app. It needs Playwright
 * available to Node:
 *
 *     npm install -g playwright
 *     node tools/browser-smoke.mjs
 *
 * The app itself has no dependencies at all. Nothing here is shipped.
 *
 * The site is served from the PARENT directory on purpose, so every page
 * is loaded from /phthalo-finance/ rather than the domain root. That is
 * the GitHub Pages project site case, and it is where absolute paths break.
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PARENT = path.resolve(ROOT, '..');
const FOLDER = path.basename(ROOT);
const PORT = Number(process.env.PORT || 8731);
const BASE = `http://127.0.0.1:${PORT}/${FOLDER}/`;
const SHOTS = path.join(HERE, 'screenshots');

const results = [];
const consoleIssues = [];
let currentStep = 'startup';

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`  ${mark}  ${name}${detail ? `\n        ${detail.replace(/\n/g, '\n        ')}` : ''}`);
}

async function step(number, title, fn) {
  currentStep = `${number}. ${title}`;
  console.log(`\n[${number}] ${title}`);
  try {
    await fn();
  } catch (error) {
    record(title, false, `threw: ${error.message}`);
  }
}

function serve() {
  const child = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
    { cwd: PARENT, stdio: 'ignore' });
  return child;
}

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(BASE);
      if (response.ok) return true;
    } catch (error) { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('The local server did not start.');
}

/* ------------------------------------------------------------------ */

const server = serve();
await waitForServer();
fs.mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({
  viewport: { width: 375, height: 812 },
  deviceScaleFactor: 2,
  acceptDownloads: true,
  colorScheme: 'dark'
});
const page = await context.newPage();

page.on('console', (message) => {
  const type = message.type();
  if (type === 'error' || type === 'warning') {
    consoleIssues.push({ step: currentStep, type, text: message.text() });
  }
});
page.on('pageerror', (error) => {
  consoleIssues.push({ step: currentStep, type: 'pageerror', text: error.message });
});
page.on('requestfailed', (request) => {
  // Price lookups are meant to be able to fail. Everything else is a bug.
  const url = request.url();
  if (url.includes('coingecko') || url.includes('gold-api') || url.includes('frankfurter')) return;
  consoleIssues.push({ step: currentStep, type: 'requestfailed', text: `${url} ${request.failure()?.errorText}` });
});

/** Report the first place two saved states differ, for a readable failure. */
function firstDifference(a, b, where = 'state') {
  if (JSON.stringify(a) === JSON.stringify(b)) return '';
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return `${where}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.join() !== keysB.join()) {
    return `${where}: different keys\n  before: ${keysA.join(', ')}\n  after:  ${keysB.join(', ')}`;
  }
  for (const key of keysA) {
    const found = firstDifference(a[key], b[key], `${where}.${key}`);
    if (found) return found;
  }
  return `${where}: differs somewhere`;
}

const $ = (selector) => page.locator(selector);
const clickAction = async (action, extra = '') => {
  await page.click(`[data-action="${action}"]${extra}`);
  await page.waitForTimeout(160);
};
const heroText = () => page.locator('#view-home .hero-value').first().innerText();
const money = (text) => Number(String(text).replace(/[£,+]/g, ''));

/* ---------------- 1. First load with empty storage ---------------- */

await step(1, 'First load with empty storage', async () => {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#view-home .card', { timeout: 5000 });

  const cards = await $('#view-home .card').count();
  record('home renders cards on a cold start', cards >= 5, `${cards} cards`);

  const hero = await heroText();
  record('net worth shows zero rather than a blank', hero === '£0.00', `hero was "${hero}"`);

  const emptyStates = await page.locator('#view-home .chart-empty-title').count();
  record('charts draw an empty state instead of nothing', emptyStates >= 3, `${emptyStates} empty states drawn`);

  const blank = await page.locator('#view-home .card-body:empty').count();
  record('no chart renders blank', blank === 0, `${blank} empty card bodies`);

  const errorsSoFar = consoleIssues.length;
  record('console is clean on first load', errorsSoFar === 0,
    consoleIssues.map((c) => `${c.type}: ${c.text}`).join('\n'));

  await page.screenshot({ path: path.join(SHOTS, '01-empty-dark.png') });
});

/* ---------------- 2. Load the demo data ---------------- */

await step(2, 'Load the demo data and check every chart', async () => {
  await page.click('.tabbar button[data-view="data"]');
  await clickAction('load-demo');
  await clickAction('run-confirm');
  await page.waitForTimeout(400);

  const hero = await heroText();
  const value = money(hero);
  record('net worth is a plausible figure', value > 10000 && value < 500000, `net worth ${hero}`);

  const svgs = await page.locator('#view-home svg.chart').count();
  record('every enabled visual drew an SVG', svgs >= 5, `${svgs} charts`);

  const stillEmpty = await page.locator('#view-home .chart-empty-title').count();
  record('no chart is stuck on its empty state', stillEmpty === 0, `${stillEmpty} empty states`);

  const titles = await page.locator('#view-home .card-title').allInnerTexts();
  const mechanical = titles.filter((t) => /^(Net worth|Combined|Allocation|Goal|Contributions) (chart|over time)$/i.test(t));
  record('titles state a finding, not the mechanic', mechanical.length === 0, titles.join(' | '));

  const bars = await page.locator('#view-home rect.bar').count();
  record('bars were drawn', bars > 5, `${bars} bars`);

  await page.screenshot({ path: path.join(SHOTS, '02-demo-dark.png'), fullPage: true });
});

/* ---------------- 3. Add money to three accounts ---------------- */

async function addMoney(accountId, amount, date = null) {
  await page.click('.tabbar button[data-view="accounts"]');
  await page.click(`[data-action="open-account"][data-arg="${accountId}"]`);
  await page.waitForSelector('#sheet .hero-value');
  await page.click('[data-action="new-tx"][data-dir="in"]');
  await page.waitForSelector('#tx-amount');
  await page.fill('#tx-amount', String(amount));
  if (date) await page.fill('#tx-date', date);
  await page.click('form[data-form="transaction"] button[type="submit"]');
  await page.waitForTimeout(220);
  await page.click('.tabbar button[data-view="home"]');
  await page.waitForTimeout(220);
}

await step(3, 'Add money to three accounts and watch everything update', async () => {
  const before = money(await heroText());
  await addMoney('acc_savings', 500);
  const afterOne = money(await heroText());
  record('net worth moved by exactly the amount added',
    Math.abs((afterOne - before) - 500) < 0.005, `${before} then ${afterOne}`);

  await addMoney('acc_current', 250.75);
  await addMoney('acc_ssisa', 1000);
  const afterThree = money(await heroText());
  record('three additions total correctly',
    Math.abs((afterThree - before) - 1750.75) < 0.005,
    `expected +1750.75, got +${(afterThree - before).toFixed(2)}`);

  const noReload = await page.evaluate(() => performance.getEntriesByType('navigation').length);
  record('the page never reloaded to update', noReload === 1, `${noReload} navigations`);
});

/* ---------------- 4. Withdraw, including too much ---------------- */

await step(4, 'Withdraw money, including more than the balance', async () => {
  await page.click('.tabbar button[data-view="accounts"]');
  await page.click('[data-action="open-account"][data-arg="acc_savings"]');
  await page.click('[data-action="new-tx"][data-dir="out"]');
  await page.waitForSelector('#tx-amount');

  await page.fill('#tx-amount', '100');
  await page.click('form[data-form="transaction"] button[type="submit"]');
  await page.waitForTimeout(200);
  record('a normal withdrawal is accepted',
    await page.locator('#sheet-backdrop').isHidden(), 'sheet closed');

  // Now try to take out far more than is there.
  await page.click('[data-action="open-account"][data-arg="acc_savings"]');
  await page.click('[data-action="new-tx"][data-dir="out"]');
  await page.waitForSelector('#tx-amount');
  await page.fill('#tx-amount', '999999');
  await page.click('form[data-form="transaction"] button[type="submit"]');
  await page.waitForTimeout(200);

  const warning = await page.locator('[data-error="form"]').innerText().catch(() => '');
  record('an over withdrawal warns instead of going through silently',
    /below zero/i.test(warning), warning || 'no warning shown');
  record('the sheet stayed open so the entry was not recorded',
    await page.locator('#sheet-backdrop').isVisible(), '');

  await page.click('[data-action="close-sheet"]');
  await page.waitForTimeout(150);
});

/* ---------------- 5. Backdated transaction reorders the line ---------------- */

await step(5, 'A backdated entry reorders the history line', async () => {
  const seriesBefore = await page.evaluate(async () => {
    const L = await import('./src/logic.js');
    const s = window.phthalo.app.state;
    return L.buildDailySeries(s, { today: window.phthalo.todayISO() }).map((p) => p.netWorthPence);
  });

  // Dated six months back, in the middle of the existing history.
  const backdate = await page.evaluate(async () => {
    const L = await import('./src/logic.js');
    return L.addMonths(window.phthalo.todayISO(), -6);
  });
  await addMoney('acc_current', 2000, backdate);

  const seriesAfter = await page.evaluate(async () => {
    const L = await import('./src/logic.js');
    const s = window.phthalo.app.state;
    return L.buildDailySeries(s, { today: window.phthalo.todayISO() }).map((p) => p.netWorthPence);
  });

  const offset = seriesAfter.length - seriesBefore.length;
  const firstChanged = seriesAfter.findIndex((v, i) => v !== seriesBefore[i - offset]);
  const lastDiff = seriesAfter[seriesAfter.length - 1] - seriesBefore[seriesBefore.length - 1];

  record('the line lifts from the backdated day, not from today',
    firstChanged > 0 && firstChanged < seriesAfter.length - 30,
    `first changed day at index ${firstChanged} of ${seriesAfter.length}`);
  record('the end of the line moved by the amount added',
    lastDiff === 200000, `moved by ${lastDiff} pence`);

  const sorted = await page.evaluate(async () => {
    const L = await import('./src/logic.js');
    const dates = L.buildDailySeries(window.phthalo.app.state,
      { today: window.phthalo.todayISO() }).map((p) => p.date);
    return dates.every((d, i) => i === 0 || d > dates[i - 1]);
  });
  record('the series is still in strict date order', sorted, '');
});

/* ---------------- 6. Edit then delete a transaction ---------------- */

await step(6, 'Edit then delete a transaction', async () => {
  await page.click('.tabbar button[data-view="activity"]');
  await page.waitForSelector('[data-action="edit-tx"]');
  const before = await page.evaluate(() => window.phthalo.app.state.transactions.length);

  await page.locator('[data-action="edit-tx"]').first().click();
  await page.waitForSelector('#tx-amount');
  const txId = await page.locator('form[data-form="transaction"]').getAttribute('data-arg');
  await page.fill('#tx-amount', '42.42');
  await page.click('form[data-form="transaction"] button[type="submit"]');
  await page.waitForTimeout(220);

  const edited = await page.evaluate((id) =>
    window.phthalo.app.state.transactions.find((t) => t.id === id).amountPence, txId);
  record('the edit saved as exact pence', edited === 4242, `stored ${edited} pence`);

  await page.click('.tabbar button[data-view="activity"]');
  await page.locator(`[data-action="edit-tx"][data-arg="${txId}"]`).first().click();
  await page.waitForSelector('[data-action="delete-tx"]');
  await clickAction('delete-tx', `[data-arg="${txId}"]`);
  await clickAction('run-confirm');
  await page.waitForTimeout(220);

  const after = await page.evaluate(() => window.phthalo.app.state.transactions.length);
  const gone = await page.evaluate((id) =>
    !window.phthalo.app.state.transactions.some((t) => t.id === id), txId);
  record('the delete removed exactly one entry', after === before - 1 && gone,
    `${before} then ${after}, removed: ${gone}`);
});

/* ---------------- 7. Goal maths against a calculator ---------------- */

await step(7, 'Set a goal and check the maths by hand', async () => {
  await page.click('.tabbar button[data-view="accounts"]');
  await page.click('[data-action="open-account"][data-arg="acc_savings"]');
  await clickAction('edit-goal', '[data-arg="acc_savings"]');
  await page.waitForSelector('#goal-target');

  const targetDate = await page.evaluate(async () => {
    const L = await import('./src/logic.js');
    return L.addDays(window.phthalo.todayISO(), 100);
  });
  await page.fill('#goal-target', '10000');
  await page.fill('#goal-date', targetDate);
  await page.fill('#goal-start', '0');
  await page.click('form[data-form="goal"] button[type="submit"]');
  await page.waitForTimeout(250);

  const checked = await page.evaluate(async () => {
    const L = await import('./src/logic.js');
    const state = window.phthalo.app.state;
    const today = window.phthalo.todayISO();
    const account = state.accounts.find((a) => a.id === 'acc_savings');
    const balance = L.balancesAt(state, today).get('acc_savings').valuePence;
    const p = L.goalProgress(account, balance, today);
    return {
      balance,
      target: p.targetPence,
      percent: p.percent,
      remaining: p.remainingPence,
      days: p.daysRemaining,
      perDay: p.rates.perDayPence,
      perWeek: p.rates.perWeekPence,
      perMonth: p.rates.perMonthPence,
      countdown: L.describeTimeRemaining(p.timeRemaining)
    };
  });

  // The same sums, done independently here.
  const expectedRemaining = 1000000 - checked.balance;
  const expectedPercent = (checked.balance / 1000000) * 100;
  const expectedPerDay = Math.ceil(expectedRemaining / 100);
  const expectedPerWeek = Math.ceil((expectedRemaining * 7) / 100);
  const expectedPerMonth = Math.ceil((expectedRemaining * 30.436875) / 100);

  record('goal target stored as pence', checked.target === 1000000, `${checked.target}`);
  record('days remaining is exactly 100', checked.days === 100, `${checked.days}`);
  record('percentage matches an independent calculation',
    Math.abs(checked.percent - expectedPercent) < 0.0001,
    `app ${checked.percent.toFixed(4)}, calculator ${expectedPercent.toFixed(4)}`);
  record('amount still needed matches',
    checked.remaining === expectedRemaining,
    `app ${checked.remaining}, calculator ${expectedRemaining}`);
  record('required per day matches', checked.perDay === expectedPerDay,
    `app ${checked.perDay}, calculator ${expectedPerDay}`);
  record('required per week matches', checked.perWeek === expectedPerWeek,
    `app ${checked.perWeek}, calculator ${expectedPerWeek}`);
  record('required per month matches', checked.perMonth === expectedPerMonth,
    `app ${checked.perMonth}, calculator ${expectedPerMonth}`);
  record('countdown reads in plain English',
    /month|day/.test(checked.countdown), checked.countdown);

  await page.click('.tabbar button[data-view="home"]');
  await page.waitForTimeout(250);
  const paceMarkers = await page.locator('#view-home .pace-marker').count();
  record('the goal chart drew a pace marker', paceMarkers >= 1, `${paceMarkers} markers`);
});

/* ---------------- 8. Custom account and visual ---------------- */

await step(8, 'Add then remove a custom account and a custom visual', async () => {
  await page.click('.tabbar button[data-view="accounts"]');
  await clickAction('add-account');
  await page.waitForSelector('#acc-name');
  await page.fill('#acc-name', 'Premium Bonds');
  await page.selectOption('#acc-type', 'balance');
  await page.selectOption('#acc-category', 'Investments');
  await page.click('form[data-form="account"] button[type="submit"]');
  await page.waitForTimeout(250);

  const added = await page.evaluate(() =>
    window.phthalo.app.state.accounts.some((a) => a.name === 'Premium Bonds'));
  record('the custom account was added', added, '');

  const colours = await page.evaluate(async () => {
    const L = await import('./src/logic.js');
    return window.phthalo.app.state.accounts
      .filter((a) => a.type !== 'liability').map((a) => L.colourForAccount(a));
  });
  record('every asset account still has a distinct colour',
    new Set(colours).size === colours.length,
    `${colours.length} accounts, ${new Set(colours).size} distinct colours`);

  // Turn on an optional visual, then turn it back off.
  await page.click('.tabbar button[data-view="home"]');
  await clickAction('open-gallery');
  await clickAction('toggle-visual', '[data-arg="holdings"]');
  await page.waitForTimeout(200);
  await clickAction('close-sheet');
  await page.waitForTimeout(250);
  const withHoldings = await page.locator('[data-visual-id="holdings"]').count();
  record('a gallery visual can be added to the home screen', withHoldings === 1, '');

  await clickAction('hide-visual', '[data-arg="holdings"]');
  await page.waitForTimeout(250);
  const withoutHoldings = await page.locator('[data-visual-id="holdings"]').count();
  record('and removed again', withoutHoldings === 0, '');

  // Reorder, then check the order actually stuck.
  const orderBefore = await page.locator('#view-home [data-visual-id]').evaluateAll(
    (els) => els.map((e) => e.dataset.visualId));
  await page.click('[data-visual-id="position"] [data-action="move-visual"][data-dir="up"]');
  await page.waitForTimeout(250);
  const orderAfter = await page.locator('#view-home [data-visual-id]').evaluateAll(
    (els) => els.map((e) => e.dataset.visualId));
  record('visuals can be reordered', orderBefore.join() !== orderAfter.join(),
    `${orderBefore.join(' > ')}  ->  ${orderAfter.join(' > ')}`);

  // Remove the custom account again.
  await page.click('.tabbar button[data-view="accounts"]');
  const customId = await page.evaluate(() =>
    window.phthalo.app.state.accounts.find((a) => a.name === 'Premium Bonds').id);
  await page.click(`[data-action="open-account"][data-arg="${customId}"]`);
  await clickAction('delete-account', `[data-arg="${customId}"]`);
  const confirmText = await page.locator('#sheet p').first().innerText();
  record('deleting an account explains that the history goes too',
    /entries|history/i.test(confirmText), confirmText.slice(0, 90));
  record('and offers to export first',
    await page.locator('#sheet [data-action="export-json"]').count() > 0, '');
  await clickAction('run-confirm');
  await page.waitForTimeout(250);
  const removed = await page.evaluate(() =>
    !window.phthalo.app.state.accounts.some((a) => a.name === 'Premium Bonds'));
  record('the custom account was removed', removed, '');
});

/* ---------------- 9. Export, clear, import ---------------- */

await step(9, 'Export, clear everything, then import the export', async () => {
  const before = await page.evaluate(() => JSON.stringify(window.phthalo.app.state));

  await page.click('.tabbar button[data-view="data"]');
  const downloadPromise = page.waitForEvent('download', { timeout: 8000 });
  await clickAction('export-json');
  const download = await downloadPromise;
  const file = path.join(SHOTS, 'export.json');
  await download.saveAs(file);
  const exported = fs.readFileSync(file, 'utf8');
  record('the export downloaded', exported.length > 500,
    `${download.suggestedFilename()}, ${exported.length} bytes`);
  record('the filename is dated', /phthalo-finance-\d{4}-\d{2}-\d{2}\.json/.test(download.suggestedFilename()),
    download.suggestedFilename());

  // Also check the CSV export while we are here.
  const csvPromise = page.waitForEvent('download', { timeout: 8000 });
  await clickAction('export-csv');
  const csv = await csvPromise;
  const csvPath = path.join(SHOTS, 'export.csv');
  await csv.saveAs(csvPath);
  const csvText = fs.readFileSync(csvPath, 'utf8');
  const csvLines = csvText.trim().split('\r\n');
  record('the CSV export has a header and a row per entry',
    csvLines[0].startsWith('Date,Account') && csvLines.length > 100,
    `${csvLines.length - 1} rows`);

  await clickAction('clear-all');
  await clickAction('run-confirm');
  await page.waitForTimeout(300);
  const cleared = await page.evaluate(() => window.phthalo.app.state.transactions.length);
  record('clearing removed every entry', cleared === 0, `${cleared} left`);

  await page.click('.tabbar button[data-view="data"]');
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 8000 });
  await clickAction('import-json');
  const chooser = await chooserPromise;
  await chooser.setFiles(file);
  await page.waitForTimeout(400);
  await clickAction('run-confirm');
  await page.waitForTimeout(400);

  const after = await page.evaluate(() => JSON.stringify(window.phthalo.app.state));
  const beforeObj = JSON.parse(before);
  const afterObj = JSON.parse(after);
  delete beforeObj.updatedAt; delete afterObj.updatedAt;
  delete beforeObj.lastExportAt; delete afterObj.lastExportAt;
  const same = JSON.stringify(beforeObj) === JSON.stringify(afterObj);
  record('import reproduced exactly the same state', same, same ? '' : firstDifference(beforeObj, afterObj));

  // And a deliberately broken file must be refused outright.
  const badPath = path.join(SHOTS, 'broken.json');
  fs.writeFileSync(badPath, '{ this is not json ');
  const badChooser = page.waitForEvent('filechooser', { timeout: 8000 });
  await clickAction('import-json');
  await (await badChooser).setFiles(badPath);
  await page.waitForTimeout(400);
  const banner = await page.locator('.banner.is-error').last().innerText().catch(() => '');
  record('a broken file is refused with a readable message',
    /not.*imported|not a valid JSON/i.test(banner), banner.replace(/\n/g, ' ').slice(0, 110));
  const survived = await page.evaluate(() => window.phthalo.app.state.transactions.length);
  record('and nothing was half loaded', survived === afterObj.transactions.length,
    `${survived} entries still there`);
});

/* ---------------- 10. Reload keeps everything ---------------- */

await step(10, 'Reload the page and confirm nothing was lost', async () => {
  const before = await page.evaluate(() => ({
    accounts: window.phthalo.app.state.accounts.length,
    transactions: window.phthalo.app.state.transactions.length,
    net: window.phthalo.app.state
  }));
  const netBefore = await page.evaluate(async () => {
    const L = await import('./src/logic.js');
    return L.netWorthAt(window.phthalo.app.state, window.phthalo.todayISO()).netWorthPence;
  });

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#view-home .card');

  const after = await page.evaluate(() => ({
    accounts: window.phthalo.app.state.accounts.length,
    transactions: window.phthalo.app.state.transactions.length
  }));
  const netAfter = await page.evaluate(async () => {
    const L = await import('./src/logic.js');
    return L.netWorthAt(window.phthalo.app.state, window.phthalo.todayISO()).netWorthPence;
  });

  record('accounts survived the reload', before.accounts === after.accounts,
    `${before.accounts} then ${after.accounts}`);
  record('entries survived the reload', before.transactions === after.transactions,
    `${before.transactions} then ${after.transactions}`);
  record('net worth is identical to the penny', netBefore === netAfter,
    `${netBefore} then ${netAfter}`);
});

/* ---------------- 11. Narrow screen ---------------- */

await step(11, 'Nothing overflows at 375px and every target is tappable', async () => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.click('.tabbar button[data-view="home"]');
  await page.waitForTimeout(400);

  for (const view of ['home', 'accounts', 'activity', 'data']) {
    await page.click(`.tabbar button[data-view="${view}"]`);
    await page.waitForTimeout(300);
    const overflow = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      win: window.innerWidth,
      widest: Array.from(document.querySelectorAll('body *'))
        .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
        .map((el) => `${el.tagName.toLowerCase()}.${el.className}`.slice(0, 60)).slice(0, 3)
    }));
    record(`no sideways scroll on the ${view} tab`,
      overflow.doc <= overflow.win + 1,
      `scrollWidth ${overflow.doc} vs viewport ${overflow.win}${overflow.widest.length ? ` - ${overflow.widest.join(', ')}` : ''}`);
  }

  const sweep = async (where) => page.evaluate(() => {
    const bad = [];
    document.querySelectorAll('button, a.button, select, input, [role="button"]').forEach((el) => {
      const box = el.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) return;      // hidden
      if (el.closest('svg')) return;                         // chart hit areas, not controls
      if (box.height < 44 || box.width < 44) {
        bad.push(`${el.tagName.toLowerCase()}[${el.dataset.action || el.type || el.className}] `
          + `${Math.round(box.width)}x${Math.round(box.height)}`);
      }
    });
    return bad;
  }).then((bad) => bad.map((b) => `${where}: ${b}`));

  let small = [];
  for (const view of ['home', 'accounts', 'activity', 'data']) {
    await page.click(`.tabbar button[data-view="${view}"]`);
    await page.waitForTimeout(280);
    small = small.concat(await sweep(view));
  }
  // And inside a sheet, where the forms live.
  await page.click('.tabbar button[data-view="accounts"]');
  await page.click('[data-action="open-account"][data-arg="acc_savings"]');
  await page.waitForTimeout(300);
  small = small.concat(await sweep('account sheet'));
  await page.click('[data-action="new-tx"][data-dir="in"]');
  await page.waitForTimeout(300);
  small = small.concat(await sweep('entry form'));
  await page.click('[data-action="close-sheet"]');
  await page.waitForTimeout(200);

  record('every control is at least 44 by 44', small.length === 0,
    small.length ? `${small.length} too small:\n${small.slice(0, 10).join('\n')}` : '');

  await page.screenshot({ path: path.join(SHOTS, '11-375-dark.png'), fullPage: true });
});

/* ---------------- 12. Themes ---------------- */

await step(12, 'Both themes stay legible', async () => {
  await page.click('.tabbar button[data-view="home"]');
  await page.waitForTimeout(250);
  await clickAction('toggle-theme');
  await page.waitForTimeout(400);
  const theme = await page.getAttribute('html', 'data-theme');
  record('the theme toggle switched to light', theme === 'light', `data-theme="${theme}"`);

  const contrast = await page.evaluate(async () => {
    const L = await import('./src/logic.js');
    const styles = getComputedStyle(document.documentElement);
    const toHex = (value) => {
      const text = String(value).trim();
      if (text.startsWith('#')) return text;              // already a hex token
      const m = text.match(/\d+/g);                        // rgb() form
      if (!m) return null;
      return `#${m.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
    };
    const surface = toHex(styles.getPropertyValue('--surface'));
    const canvas = toHex(styles.getPropertyValue('--canvas'));
    const checks = [];
    for (const token of ['--ink', '--muted', '--positive-text', '--negative-text', '--accent-text']) {
      const hex = toHex(styles.getPropertyValue(token));
      checks.push({
        token,
        onSurface: L.contrastRatio(hex, surface),
        onCanvas: L.contrastRatio(hex, canvas)
      });
    }
    return checks;
  });
  const failing = contrast.filter((c) => c.onSurface < 4.5 || c.onCanvas < 4.5);
  record('every text token reaches AA in the light theme', failing.length === 0,
    failing.map((f) => `${f.token} ${f.onSurface.toFixed(2)}/${f.onCanvas.toFixed(2)}`).join(', ')
    || contrast.map((c) => `${c.token} ${c.onSurface.toFixed(1)}`).join(', '));

  const charts = await page.locator('#view-home svg.chart').count();
  record('charts still render in the light theme', charts >= 5, `${charts} charts`);
  await page.screenshot({ path: path.join(SHOTS, '12-375-light.png'), fullPage: true });

  await clickAction('toggle-theme');
  await page.waitForTimeout(300);
  record('and back to dark', (await page.getAttribute('html', 'data-theme')) === 'dark', '');
});

/* ---------------- Extra: offline, wide screen, price failure ---------------- */

await step('A', 'The app works with the network disconnected', async () => {
  await page.waitForTimeout(600);   // let the service worker settle
  const swReady = await page.evaluate(() =>
    navigator.serviceWorker ? navigator.serviceWorker.ready.then(() => true).catch(() => false) : false);
  record('a service worker is in control', swReady === true, '');

  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(900);
  const worksOffline = await page.locator('#view-home .card').count();
  record('the app still loads and draws with no network', worksOffline >= 5, `${worksOffline} cards`);

  const offlineNet = await page.locator('#view-home .hero-value').first().innerText().catch(() => '');
  record('the data is still there offline', /£/.test(offlineNet), offlineNet);

  // A price refresh with no network must fail safely.
  const pricesBefore = await page.evaluate(() =>
    window.phthalo.app.state.accounts.filter((a) => a.type === 'quantity')
      .map((a) => `${a.id}:${a.unitPricePence}`).join(','));
  await clickAction('refresh-prices');
  await page.waitForTimeout(6500);
  const pricesAfter = await page.evaluate(() =>
    window.phthalo.app.state.accounts.filter((a) => a.type === 'quantity')
      .map((a) => `${a.id}:${a.unitPricePence}`).join(','));
  record('a failed price refresh keeps every manual price', pricesBefore === pricesAfter, '');
  const notice = await page.locator('.banner').last().innerText().catch(() => '');
  record('and says so without blocking anything', /left as they were|kept the last manual/i.test(notice),
    notice.replace(/\n/g, ' ').slice(0, 110));
  const stillUsable = await page.locator('#view-home svg.chart').count();
  record('the app is still fully usable after the failure', stillUsable >= 5, `${stillUsable} charts`);

  await context.setOffline(false);
});

await step('B', 'The layout widens gracefully', async () => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#view-home .card');
  await page.waitForTimeout(400);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  record('no sideways scroll at 1024px', overflow, '');
  const columns = await page.evaluate(() => {
    const list = document.querySelector('.visual-list');
    return getComputedStyle(list).gridTemplateColumns.split(' ').length;
  });
  record('the grid uses more than one column on a wide screen', columns >= 2, `${columns} columns`);
  await page.screenshot({ path: path.join(SHOTS, 'B-1024-dark.png'), fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
});

await step('C', 'The in browser test page passes', async () => {
  const testPage = await context.newPage();
  const issues = [];
  testPage.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') issues.push(m.text());
  });
  testPage.on('pageerror', (e) => issues.push(e.message));
  await testPage.goto(`${BASE}tests.html`, { waitUntil: 'networkidle' });
  await testPage.waitForFunction(() => !/Running/.test(document.getElementById('summary').textContent),
    { timeout: 30000 });
  const summary = await testPage.locator('#summary').innerText();
  const failures = await testPage.locator('.result.fail').count();
  record('tests.html reports every test passing', failures === 0 && /All \d+ tests passed/.test(summary),
    summary);
  record('tests.html has a clean console', issues.length === 0, issues.join('\n'));
  await testPage.screenshot({ path: path.join(SHOTS, 'C-tests.png'), fullPage: true });
  await testPage.close();
});


/* ---------------- D. Storage failure modes and migration ---------------- */

await step('D', 'The three storage failure modes, and an old saved file', async () => {
  // (a) Corrupt JSON with no usable backup.
  const corrupt = await context.newPage();
  await corrupt.goto(BASE, { waitUntil: 'networkidle' });
  await corrupt.evaluate(() => {
    localStorage.setItem('phthalo.finance.v1', '{ this is not json');
    localStorage.removeItem('phthalo.finance.v1.backup');
  });
  await corrupt.reload({ waitUntil: 'networkidle' });
  await corrupt.waitForTimeout(500);
  const corruptBanner = await corrupt.locator('.banner.is-error').first().innerText().catch(() => '');
  record('corrupt saved data shows a banner rather than a blank screen',
    /could not be read/i.test(corruptBanner), corruptBanner.replace(/\n/g, ' ').slice(0, 100));
  record('and offers to download the damaged file',
    await corrupt.locator('[data-action="export-damaged"]').count() > 0, '');
  record('and the app is still usable',
    await corrupt.locator('#view-home .card').count() >= 5, '');
  record('nothing was silently deleted',
    (await corrupt.evaluate(() => localStorage.getItem('phthalo.finance.v1'))) !== null,
    'the damaged value is still in storage');
  await corrupt.close();

  // (b) Corrupt main copy, but the rolling backup survives.
  const recovered = await context.newPage();
  await recovered.goto(BASE, { waitUntil: 'networkidle' });
  await recovered.evaluate(() => {
    const good = JSON.stringify({
      schemaVersion: 1, accounts: [{ id: 'a', name: 'Rescued', type: 'balance', category: 'Cash' }],
      transactions: [{ id: 't', accountId: 'a', date: '2026-01-01', direction: 'in', amountPence: 4200 }]
    });
    localStorage.setItem('phthalo.finance.v1.backup', good);
    localStorage.setItem('phthalo.finance.v1', 'half a written {');
  });
  await recovered.reload({ waitUntil: 'networkidle' });
  await recovered.waitForTimeout(500);
  const recoveredBanner = await recovered.locator('.banner.is-error').first().innerText().catch(() => '');
  record('a damaged main copy falls back to the rolling backup',
    /rolling backup/i.test(recoveredBanner), recoveredBanner.replace(/\n/g, ' ').slice(0, 100));
  const rescued = await recovered.evaluate(() =>
    window.phthalo.app.state.accounts.some((a) => a.name === 'Rescued'));
  record('and the backed up data really is loaded', rescued === true, '');
  await recovered.close();

  // (c) Storage switched off completely, which is what private browsing does.
  const disabled = await browser.newContext({ viewport: { width: 375, height: 812 } });
  await disabled.addInitScript(() => {
    const blow = () => { const e = new Error('denied'); e.name = 'SecurityError'; throw e; };
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { return { getItem: blow, setItem: blow, removeItem: blow, clear: blow, key: blow, length: 0 }; }
    });
  });
  const noStore = await disabled.newPage();
  const noStoreErrors = [];
  noStore.on('pageerror', (e) => noStoreErrors.push(e.message));
  await noStore.goto(BASE, { waitUntil: 'networkidle' });
  await noStore.waitForTimeout(500);
  const disabledBanner = await noStore.locator('.banner.is-error').first().innerText().catch(() => '');
  record('storage being switched off shows a clear warning',
    /will not let the app save|blocking storage/i.test(disabledBanner),
    disabledBanner.replace(/\n/g, ' ').slice(0, 110));
  record('and the app still runs rather than crashing',
    await noStore.locator('#view-home .card').count() >= 5, '');
  record('and it never throws with storage denied', noStoreErrors.length === 0,
    noStoreErrors.join('; '));
  await disabled.close();

  // (d) Quota exceeded on write.
  const full = await browser.newContext({ viewport: { width: 375, height: 812 } });
  await full.addInitScript(() => {
    const real = window.localStorage.setItem.bind(window.localStorage);
    let armed = false;
    window.__armQuota = () => { armed = true; };
    window.localStorage.setItem = function setItem(key, value) {
      if (armed && key.startsWith('phthalo.finance.v1')) {
        const e = new Error('quota'); e.name = 'QuotaExceededError'; e.code = 22;
        throw e;
      }
      return real(key, value);
    };
  });
  const fullPage = await full.newPage();
  await fullPage.goto(BASE, { waitUntil: 'networkidle' });
  await fullPage.waitForTimeout(400);
  await fullPage.evaluate(() => window.__armQuota());
  // Make any change at all, which triggers an autosave.
  await fullPage.click('.tabbar button[data-view="accounts"]');
  await fullPage.click('[data-action="open-account"][data-arg="acc_savings"]');
  await fullPage.click('[data-action="new-tx"][data-dir="in"]');
  await fullPage.waitForSelector('#tx-amount');
  await fullPage.fill('#tx-amount', '25');
  await fullPage.click('form[data-form="transaction"] button[type="submit"]');
  await fullPage.waitForTimeout(500);
  const quotaBanner = await fullPage.locator('.banner.is-error').first().innerText().catch(() => '');
  record('a full storage quota is reported rather than swallowed',
    /not saved|run out of storage/i.test(quotaBanner), quotaBanner.replace(/\n/g, ' ').slice(0, 110));
  record('and the banner offers a backup download',
    await fullPage.locator('.banner [data-action="export-json"]').count() > 0, '');
  record('and the change is still visible on screen',
    /£/.test(await fullPage.locator('#view-accounts .hero-value').first().innerText()), '');
  await full.close();

  // (e) An older saved file is migrated rather than discarded.
  const old = await context.newPage();
  await old.goto(BASE, { waitUntil: 'networkidle' });
  await old.evaluate(() => {
    // Version 0: no schemaVersion, money as floating point pounds.
    localStorage.setItem('phthalo.finance.v1', JSON.stringify({
      accounts: [
        { id: 'sav', name: 'Old savings', type: 'balance', category: 'Cash',
          goalTarget: 10000, goalDate: '2027-01-01' },
        { id: 'btc', name: 'Old bitcoin', units: 0.5, unit: 'BTC', unitPrice: 42000.5, category: 'Crypto' }
      ],
      transactions: [
        { id: 't1', accountId: 'sav', date: '2026-01-01', amount: 1234.56 },
        { id: 't2', accountId: 'sav', date: '2026-02-01', amount: -34.56 }
      ]
    }));
    localStorage.removeItem('phthalo.finance.v1.backup');
  });
  await old.reload({ waitUntil: 'networkidle' });
  await old.waitForTimeout(500);
  const migratedBanner = await old.locator('.banner').first().innerText().catch(() => '');
  record('an old saved file is upgraded, with a note saying so',
    /upgraded/i.test(migratedBanner), migratedBanner.replace(/\n/g, ' ').slice(0, 110));
  const migrated = await old.evaluate(() => {
    const s = window.phthalo.app.state;
    const sav = s.accounts.find((a) => a.id === 'sav');
    return {
      schema: s.schemaVersion,
      accounts: s.accounts.length,
      transactions: s.transactions.length,
      firstAmount: s.transactions.find((t) => t.id === 't1').amountPence,
      secondDirection: s.transactions.find((t) => t.id === 't2').direction,
      goalPence: sav.goal ? sav.goal.targetPence : null,
      btcType: s.accounts.find((a) => a.id === 'btc').type
    };
  });
  record('pounds became integer pence', migrated.firstAmount === 123456, `${migrated.firstAmount}`);
  record('a negative amount became a withdrawal', migrated.secondDirection === 'out', '');
  record('the goal came across', migrated.goalPence === 1000000, `${migrated.goalPence}`);
  record('the quantity account kept its type', migrated.btcType === 'quantity', migrated.btcType);
  record('nothing was dropped in the upgrade',
    migrated.accounts === 2 && migrated.transactions === 2,
    `${migrated.accounts} accounts, ${migrated.transactions} entries`);
  await old.close();
});


/* ---------------- E. Single account, and interface prose ---------------- */

await step('E', 'Every chart with exactly one account, and the interface wording', async () => {
  const solo = await context.newPage();
  await solo.goto(BASE, { waitUntil: 'networkidle' });
  await solo.evaluate(() => {
    localStorage.setItem('phthalo.finance.v1', JSON.stringify({
      schemaVersion: 1,
      accounts: [{ id: 'only', name: 'Savings account', type: 'balance', category: 'Cash',
        order: 0, colourIndex: 5, archived: false, note: '',
        goal: { targetPence: 500000, targetDate: '2027-06-01', startDate: '2026-01-01', startPence: 0 } }],
      transactions: [
        { id: 'x1', accountId: 'only', date: '2026-03-01', direction: 'in', amountPence: 120000,
          unitsE8: 0, unitPricePence: null, note: '', createdAt: '2026-03-01T00:00:00.000Z' },
        { id: 'x2', accountId: 'only', date: '2026-07-01', direction: 'in', amountPence: 80000,
          unitsE8: 0, unitPricePence: null, note: '', createdAt: '2026-07-01T00:00:00.000Z' }
      ],
      visuals: Object.keys({ netWorth: 1, position: 1, allocation: 1, goals: 1, contributions: 1,
        monthlyNet: 1, holdings: 1, categoryTotals: 1 }).map((id, i) => ({ id, enabled: true, order: i }))
    }));
  });
  await solo.reload({ waitUntil: 'networkidle' });
  await solo.waitForTimeout(600);

  const cards = await solo.locator('#view-home [data-visual-id]').count();
  record('all eight visuals render with a single account', cards === 8, `${cards} cards`);
  const broken = await solo.locator('#view-home .chart-error').count();
  record('none of them errored', broken === 0, `${broken} errors`);
  const blank = await solo.locator('#view-home .card-body:empty').count();
  record('none of them is blank', blank === 0, `${blank} blank`);
  const hero = await solo.locator('#view-home .hero-value').first().innerText();
  record('net worth is right with one account', hero === '£2,000.00', hero);
  const titles = await solo.locator('#view-home .card-title').allInnerTexts();
  record('every card still has a plain English title',
    titles.length === 8 && titles.every((t) => t.trim().length > 3), titles.join(' | '));
  const overflow = await solo.evaluate(() =>
    document.documentElement.scrollWidth <= window.innerWidth + 1);
  record('and nothing overflows sideways', overflow, '');
  await solo.screenshot({ path: path.join(SHOTS, 'E-single-account.png'), fullPage: true });

  // Interface prose must not contain dashes or hyphenated words.
  const prose = await solo.evaluate(() => {
    const seen = new Set();
    document.querySelectorAll('#view-home, .app-header, .tabbar, .banner').forEach((root) => {
      root.querySelectorAll('*').forEach((el) => {
        for (const node of el.childNodes) {
          if (node.nodeType === 3 && node.textContent.trim()) seen.add(node.textContent.trim());
        }
      });
    });
    return Array.from(seen);
  });
  const dashed = prose.filter((t) => /[\u2013\u2014]/.test(t));
  record('no em or en dashes in the interface', dashed.length === 0, dashed.join(' | '));
  const hyphenated = prose.filter((t) => /[A-Za-z]{2,}-[A-Za-z]{2,}/.test(t));
  record('no hyphenated words in the interface prose', hyphenated.length === 0,
    hyphenated.join(' | '));
  await solo.close();
});

/* ---------------- 13. Console ---------------- */

await step(13, 'The browser console is clean throughout', async () => {
  // Chromium logs its own entry for any network request that fails. When
  // the offline test deliberately pulls the plug on a price lookup, that
  // line appears no matter how carefully the app catches the error, so it
  // is reported separately rather than counted as application noise.
  const unavoidable = consoleIssues.filter((c) =>
    /ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_CHANGED|Failed to fetch/.test(c.text)
    && /disconnected/i.test(c.step));
  const real = consoleIssues.filter((c) => !unavoidable.includes(c));

  record('no console errors or warnings during normal use', real.length === 0,
    real.map((c) => `[${c.step}] ${c.type}: ${c.text}`).join('\n'));

  if (unavoidable.length) {
    console.log(`  NOTE  ${unavoidable.length} browser level network log line(s) during the `
      + 'deliberate offline test. These come from Chromium itself, not from the app, and cannot '
      + 'be suppressed by a page. The app caught every one of them and carried on.');
  }
});

/* ------------------------------------------------------------------ */

await browser.close();
server.kill();

const failed = results.filter((r) => !r.ok);
console.log(`\n${'='.repeat(64)}`);
console.log(`${results.length - failed.length} of ${results.length} checks passed`);
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`);
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? `\n      ${f.detail.replace(/\n/g, '\n      ')}` : ''}`);
}
console.log(`${'='.repeat(64)}`);
process.exit(failed.length ? 1 : 0);
