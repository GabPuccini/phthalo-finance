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
