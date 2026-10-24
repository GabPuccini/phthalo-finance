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
 * Deliberately not named smoke-test.mjs: anything ending in -test.mjs is
 * picked up by `node --test`, which would then try to launch a browser.
 *
 * The site is served from the PARENT directory on purpose, so every page
 * is loaded from /phthalo-finance/ rather than the domain root. That is
 * the GitHub Pages project site case, where absolute paths break.
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
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${String(detail).replace(/\n/g, '\n        ')}` : ''}`);
}

async function step(number, title, fn) {
  currentStep = `${number}. ${title}`;
  console.log(`\n[${number}] ${title}`);
  try {
    await fn();
  } catch (error) {
    record(title, false, `threw: ${error.message.split('\n')[0]}`);
  }
}

function firstDifference(a, b, where = 'state') {
  if (JSON.stringify(a) === JSON.stringify(b)) return '';
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return `${where}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.join() !== keysB.join()) return `${where}: different keys\n  before: ${keysA}\n  after:  ${keysB}`;
  for (const key of keysA) {
    const found = firstDifference(a[key], b[key], `${where}.${key}`);
    if (found) return found;
  }
  return `${where}: differs somewhere`;
}

/* ------------------------------------------------------------------ */

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: PARENT, stdio: 'ignore' });
for (let i = 0; i < 60; i += 1) {
  try { if ((await fetch(BASE)).ok) break; } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 150));
}
fs.mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({
  viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, acceptDownloads: true, colorScheme: 'dark'
});
const page = await context.newPage();

page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') consoleIssues.push({ step: currentStep, type: m.type(), text: m.text() });
});
page.on('pageerror', (e) => consoleIssues.push({ step: currentStep, type: 'pageerror', text: e.message }));
page.on('requestfailed', (request) => {
  const url = request.url();
  if (/coingecko|gold-api|frankfurter/.test(url)) return; // allowed to fail
  consoleIssues.push({ step: currentStep, type: 'requestfailed', text: `${url} ${request.failure()?.errorText}` });
});

const pause = (ms = 180) => page.waitForTimeout(ms);
const tab = async (view) => { await page.click(`.tabbar button[data-view="${view}"]`); await pause(250); };
const act = async (selector) => { await page.click(selector); await pause(); };
const confirm = () => act('#sheet [data-action="run-confirm"]');
const money = (text) => Number(String(text).replace(/[£,+\s]/g, ''));
const heroValue = () => page.locator('#hero-value').innerText();
const state = () => page.evaluate(() => window.phthalo.app.state);
const logic = (fn, arg) => page.evaluate(async ([source, a]) => {
  const L = await import('./src/logic.js');
  return new Function('L', 'state', 'today', 'arg', source)(L, window.phthalo.app.state, window.phthalo.todayISO(), a);
}, [fn, arg]);

async function openAccount(id) {
  if (await page.locator('#view-account').isVisible()) await act('#view-account [data-action="back"]');
  if (!(await page.locator('#view-home').isVisible())) await tab('home');
  await act(`#view-home [data-action="open-account"][data-arg="${id}"]`);
  await page.waitForSelector('#view-account .detail-title');
}

async function addEntry(accountId, amount, { direction = 'in', date = null } = {}) {
  await openAccount(accountId);
  await act(`#view-account .quick-actions [data-action="new-tx"][data-dir="${direction}"]`);
  await page.waitForSelector('#tx-amount');
  await page.fill('#tx-amount', String(amount));
  if (date) await page.fill('#tx-date', date);
  await act('form[data-form="transaction"] button[type="submit"]');
  await pause(200);
}

async function goHome() {
  if (await page.locator('#view-account').isVisible()) await act('#view-account [data-action="back"]');
  await tab('home');
}

/* ---------------- 1. First load ---------------- */

await step(1, 'First load with empty storage', async () => {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#view-home .account-card');
  // Give the service worker time to install and take charge of the page.
  await page.waitForTimeout(1500);

  record('net worth shows zero rather than a blank', (await heroValue()) === '£0.00', await heroValue());
  record('the default accounts are listed', (await page.locator('#view-home .account-card').count()) === 10);
  record('the hero draws an empty state instead of nothing',
    (await page.locator('#view-home .chart-empty-title').count()) === 1);
  const navigations = await page.evaluate(() => performance.getEntriesByType('navigation').length);
  const reloaded = await page.evaluate(() => performance.getEntriesByType('navigation')[0].type);
  record('the first visit does not reload itself when the service worker takes over',
    navigations === 1 && reloaded === 'navigate', `navigation type: ${reloaded}`);
  record('the first visit says welcome', /Welcome/.test(await page.locator('#banners').innerText()));

  await tab('insights');
  const cards = await page.locator('#view-insights [data-visual-id]').count();
  record('Insights shows its four default charts', cards === 4, `${cards} charts`);
  const empty = await page.locator('#view-insights .chart-empty-title').count();
  record('every empty chart says what to add', empty === 4, `${empty} empty states`);
  record('no chart renders blank', (await page.locator('#view-insights .card-body:empty').count()) === 0);
  record('console is clean on first load', consoleIssues.length === 0, consoleIssues.map((c) => c.text).join('\n'));
  await tab('home');
  await page.screenshot({ path: path.join(SHOTS, '01-first-run.png') });
});

/* ---------------- 2. Demo data ---------------- */

await step(2, 'Load the demo data and check every chart', async () => {
  await tab('settings');
  await act('[data-action="load-demo"]');
  await confirm();
  await pause(400);

  const value = money(await heroValue());
  record('net worth is a plausible figure', value > 10000 && value < 500000, await heroValue());
  record('the hero line is drawn', (await page.locator('#view-home .hero-chart svg[data-points]').count()) === 1);
  const progress = await page.locator('#view-home .progress > span').evaluateAll((els) =>
    els.map((e) => Math.round(e.getBoundingClientRect().height)));
  record('goal progress bars are visible on Home', progress.length === 4 && progress.every((h) => h >= 5),
    `${progress.length} bars, heights ${progress.join(', ')}px`);

  await tab('insights');
  record('every chart drew', (await page.locator('#view-insights svg.chart').count()) >= 4);
  record('no chart is stuck on its empty state', (await page.locator('#view-insights .chart-empty-title').count()) === 0);
  const titles = await page.locator('#view-insights .card-title').allInnerTexts();
  record('titles state a finding, not the mechanic',
    titles.every((t) => /\d|No |All |behind|ahead/.test(t)), titles.join(' | '));
  record('marks were drawn', (await page.locator('#view-insights path.mark, #view-insights rect.mark').count()) > 20);
  record('every chart has a table of its numbers',
    (await page.locator('#view-insights details.table-view').count()) === 4);

  // Category colours appear only on the allocation bar.
  const fills = await page.locator('#view-insights [data-visual-id="position"] .mark').evaluateAll((els) =>
    [...new Set(els.map((e) => e.getAttribute('fill')))]);
  record('the account bars use one colour, with debt in red',
    fills.length === 2 && fills.includes('var(--accent)') && fills.includes('var(--negative)'), fills.join(', '));
  await page.screenshot({ path: path.join(SHOTS, '02-insights-dark.png'), fullPage: true });
  await tab('home');
  await page.evaluate(() => { window.scrollTo(0, 0); });
  await page.screenshot({ path: path.join(SHOTS, '02-home-dark.png') });
});

/* ---------------- 3. Add money ---------------- */

await step(3, 'Add money to three accounts and watch everything update', async () => {
  await tab('home');
  const before = money(await heroValue());
  await addEntry('acc_savings', 500);
  await goHome();
  const afterOne = money(await heroValue());
  record('net worth moved by exactly the amount added', Math.abs(afterOne - before - 500) < 0.005, `${before} then ${afterOne}`);

  await addEntry('acc_current', 250.75);
  await addEntry('acc_ssisa', 1000);
  await goHome();
  const afterThree = money(await heroValue());
  record('three additions total correctly', Math.abs(afterThree - before - 1750.75) < 0.005,
    `expected +1750.75, got +${(afterThree - before).toFixed(2)}`);
  const navs = await page.evaluate(() => performance.getEntriesByType('navigation').length);
  record('the page never reloaded to update', navs === 1);

  // The floating button reaches every account.
  await act('#fab');
  record('the add button opens a list of every account',
    (await page.locator('#sheet [data-action="new-tx"]').count()) === 10);
  await act('#sheet [data-action="close-sheet"]');
});

/* ---------------- 4. Withdraw ---------------- */

await step(4, 'Withdraw money, including more than the balance', async () => {
  await addEntry('acc_savings', 100, { direction: 'out' });
  record('a normal withdrawal is accepted', await page.locator('#sheet-backdrop').isHidden());

  await act('#view-account .quick-actions [data-action="new-tx"][data-dir="out"]');
  await page.fill('#tx-amount', '999999');
  await act('form[data-form="transaction"] button[type="submit"]');
  const warning = await page.locator('[data-error="form"]').innerText().catch(() => '');
  record('an over withdrawal warns instead of going through silently', /below zero/i.test(warning), warning);
  record('the form stayed open so nothing was recorded', await page.locator('#sheet-backdrop').isVisible());
  await act('#sheet [data-action="close-sheet"]');
});

/* ---------------- 5. Backdating ---------------- */

await step(5, 'A backdated entry reorders the history line', async () => {
  const series = 'return L.buildDailySeries(state, { today }).map((p) => [p.date, p.netWorthPence]);';
  const before = await logic(series);
  const backdate = await logic('return L.addMonths(today, -6);');
  await addEntry('acc_current', 2000, { date: backdate });
  const after = await logic(series);
  const beforeMap = new Map(before);
  const firstChanged = after.findIndex(([d, v]) => beforeMap.get(d) !== v);
  record('the line lifts from the backdated day, not from today', after[firstChanged][0] === backdate,
    `first changed day ${after[firstChanged][0]}, backdated to ${backdate}`);
  record('the end of the line moved by the amount added',
    after[after.length - 1][1] - before[before.length - 1][1] === 200000);
  record('the series is still in strict date order', after.every((p, i) => i === 0 || p[0] > after[i - 1][0]));
});

/* ---------------- 6. Edit then delete ---------------- */

await step(6, 'Edit then delete a transaction', async () => {
  await goHome();
  await tab('activity');
  const before = (await state()).transactions.length;
  await act('#view-activity [data-action="edit-tx"]');
  const txId = await page.locator('form[data-form="transaction"]').getAttribute('data-arg');
  await page.fill('#tx-amount', '42.42');
  await act('form[data-form="transaction"] button[type="submit"]');
  const edited = (await state()).transactions.find((t) => t.id === txId).amountPence;
  record('the edit saved as exact pence', edited === 4242, `stored ${edited}`);

  await act(`#view-activity [data-action="edit-tx"][data-arg="${txId}"]`);
  await act(`#sheet [data-action="delete-tx"][data-arg="${txId}"]`);
  await confirm();
  const after = (await state()).transactions;
  record('the delete removed exactly one entry', after.length === before - 1 && !after.some((t) => t.id === txId),
    `${before} then ${after.length}`);
});

/* ---------------- 7. Goal maths ---------------- */

await step(7, 'Set a goal and check the maths by hand', async () => {
  await openAccount('acc_savings');
  await act('#view-account [data-action="edit-goal"]');
  const target = await logic('return L.addDays(today, 100);');
  await page.fill('#goal-target', '10000');
  await page.fill('#goal-date', target);
  await page.fill('#goal-start', '0');
  await act('form[data-form="goal"] button[type="submit"]');

  const p = await logic(`const a = state.accounts.find((x) => x.id === 'acc_savings');
    const balance = L.balancesAt(state, today).get('acc_savings').valuePence;
    const g = L.goalProgress(a, balance, today);
    return { balance, target: g.targetPence, percent: g.percent, remaining: g.remainingPence, days: g.daysRemaining,
      day: g.rates.perDayPence, week: g.rates.perWeekPence, month: g.rates.perMonthPence };`);
  const remaining = 1000000 - p.balance;
  record('days remaining is exactly 100', p.days === 100);
  record('percentage matches an independent calculation', Math.abs(p.percent - (p.balance / 10000)) < 1e-9,
    `${p.percent.toFixed(4)}`);
  record('amount still needed matches', p.remaining === remaining);
  record('per day matches', p.day === Math.ceil(remaining / 100), `${p.day}`);
  record('per week matches', p.week === Math.ceil((remaining * 7) / 100), `${p.week}`);
  record('per month matches', p.month === Math.ceil((remaining * 30.436875) / 100), `${p.month}`);

  // And the goal screen shows those same figures.
  const shown = await page.locator('#view-account .stat-trio .stat-mid').allInnerTexts();
  const expected = await logic(`return [arg.day, arg.week, arg.month].map((v) => L.formatMoney(v));`, p);
  record('the goal screen shows the same daily, weekly and monthly figures',
    JSON.stringify(shown) === JSON.stringify(expected), shown.join(', '));
  record('the ring shows the same percentage',
    (await page.locator('#view-account .ring-percent').innerText()) === `${Math.round(p.percent)}%`);
  record('the target date and countdown are shown',
    /Target on/i.test(await page.locator('#view-account .target-pill').innerText())
    && /to go/.test(await page.locator('#view-account .target-countdown').innerText()));

  await tab('insights').catch(() => {});
  await goHome();
  await tab('insights');
  record('the goal chart draws a pace marker', (await page.locator('#view-insights .pace-marker').count()) >= 1);
});

/* ---------------- 8. Custom account and visual ---------------- */

await step(8, 'Add then remove a custom account and a chart', async () => {
  await tab('home');
  await act('#view-home [data-action="add-account"]');
  await page.fill('#acc-name', 'Premium Bonds');
  await page.selectOption('#acc-type', 'balance');
  await page.selectOption('#acc-category', 'Investments');
  await act('form[data-form="account"] button[type="submit"]');
  const custom = (await state()).accounts.find((a) => a.name === 'Premium Bonds');
  record('the custom account was added', Boolean(custom));
  record('it appears on Home with its category badge',
    (await page.locator(`#view-home [data-arg="${custom.id}"] .badge-investments`).count()) === 1);

  await tab('insights');
  await act('#view-insights [data-action="open-gallery"]');
  await act('#sheet [data-action="toggle-visual"][data-arg="holdings"]');
  await act('#sheet [data-action="close-sheet"]');
  record('a chart can be switched on', (await page.locator('[data-visual-id="holdings"]').count()) === 1);
  await act('[data-visual-id="holdings"] [data-action="hide-visual"]');
  record('and removed again', (await page.locator('[data-visual-id="holdings"]').count()) === 0);

  const order = () => page.locator('#view-insights [data-visual-id]').evaluateAll((els) => els.map((e) => e.dataset.visualId));
  const before = await order();
  await act('[data-visual-id="allocation"] [data-action="move-visual"][data-dir="up"]');
  const after = await order();
  record('charts can be reordered', before.join() !== after.join() && after[0] === 'allocation',
    `${before.join(' > ')}  ->  ${after.join(' > ')}`);

  await openAccount(custom.id);
  await act('#view-account [data-action="delete-account"]');
  const text = await page.locator('#sheet .sheet-body').innerText();
  record('deleting explains that the history goes too', /entries/.test(text), text.slice(0, 80));
  record('and offers to export first', (await page.locator('#sheet [data-action="export-json"]').count()) === 1);
  await confirm();
  record('the custom account was removed', !(await state()).accounts.some((a) => a.name === 'Premium Bonds'));
  record('and the app returned to Home', await page.locator('#view-home').isVisible());
});

/* ---------------- 9. Export, clear, import ---------------- */

await step(9, 'Export, clear everything, then import the export', async () => {
  const before = JSON.stringify(await state());
  await tab('settings');
  const download = page.waitForEvent('download', { timeout: 8000 });
  await act('#view-settings [data-action="export-json"]');
  const file = path.join(SHOTS, 'export.json');
  const dl = await download;
  await dl.saveAs(file);
  record('the export downloaded with a dated name', /phthalo-finance-\d{4}-\d{2}-\d{2}\.json/.test(dl.suggestedFilename()),
    dl.suggestedFilename());

  const csvDownload = page.waitForEvent('download', { timeout: 8000 });
  await act('#view-settings [data-action="export-csv"]');
  const csvPath = path.join(SHOTS, 'export.csv');
  await (await csvDownload).saveAs(csvPath);
  const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\r\n');
  record('the CSV has a header and a row per entry', lines[0].startsWith('Date,Account') && lines.length > 100, `${lines.length - 1} rows`);

  await act('#view-settings [data-action="clear-all"]');
  await confirm();
  record('clearing removed every entry', (await state()).transactions.length === 0);

  await tab('settings');
  const chooser = page.waitForEvent('filechooser', { timeout: 8000 });
  await act('#view-settings [data-action="import-json"]');
  await (await chooser).setFiles(file);
  await pause(400);
  await confirm();
  await pause(300);
  const a = JSON.parse(before);
  const b = await state();
  for (const s of [a, b]) { delete s.updatedAt; delete s.lastExportAt; }
  const same = JSON.stringify(a) === JSON.stringify(b);
  record('import reproduced exactly the same state', same, same ? '' : firstDifference(a, b));

  fs.writeFileSync(path.join(SHOTS, 'broken.json'), '{ this is not json ');
  await tab('settings');
  const bad = page.waitForEvent('filechooser', { timeout: 8000 });
  await act('#view-settings [data-action="import-json"]');
  await (await bad).setFiles(path.join(SHOTS, 'broken.json'));
  await pause(400);
  const banner = await page.locator('.banner.is-error').last().innerText().catch(() => '');
  record('a broken file is refused with a readable message', /not imported/i.test(banner), banner.replace(/\n/g, ' ').slice(0, 100));
  record('and nothing was half loaded', (await state()).transactions.length === b.transactions.length);
});

/* ---------------- 10. Reload ---------------- */

await step(10, 'Reload the page and confirm nothing was lost', async () => {
  const before = await logic('return [state.accounts.length, state.transactions.length, L.netWorthAt(state, today).netWorthPence];');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#view-home .account-card');
  const after = await logic('return [state.accounts.length, state.transactions.length, L.netWorthAt(state, today).netWorthPence];');
  record('accounts, entries and net worth survive to the penny', JSON.stringify(before) === JSON.stringify(after),
    `${before.join(' / ')}  then  ${after.join(' / ')}`);
});

/* ---------------- 11. Narrow screen ---------------- */

await step(11, 'Nothing overflows at 375px and every target is tappable', async () => {
  await page.setViewportSize({ width: 375, height: 812 });
  const sweep = (where) => page.evaluate((w) => {
    const bad = [];
    document.querySelectorAll('button, a.button, select, input, summary, [role="button"]').forEach((el) => {
      const box = el.getBoundingClientRect();
      if (!box.width && !box.height) return;
      if (el.closest('svg')) return;
      if (box.height < 44 || box.width < 44) bad.push(`${w}: ${el.tagName.toLowerCase()}[${el.dataset.action || el.type || el.className}] ${Math.round(box.width)}x${Math.round(box.height)}`);
    });
    return bad;
  }, where);
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

  let small = [];
  for (const view of ['home', 'insights', 'activity', 'settings']) {
    await tab(view);
    record(`no sideways scroll on ${view}`, await overflow());
    small = small.concat(await sweep(view));
  }
  await openAccount('acc_bitcoin');
  record('no sideways scroll on an account', await overflow());
  small = small.concat(await sweep('account'));
  await act('#view-account [data-action="account-tab"][data-tab="records"]');
  small = small.concat(await sweep('records'));
  await act('#view-account [data-action="account-tab"][data-tab="overview"]');
  await act('#view-account .quick-actions [data-action="new-tx"][data-dir="in"]');
  small = small.concat(await sweep('entry form'));
  await act('#sheet [data-action="close-sheet"]');
  record('every control is at least 44 by 44', small.length === 0, small.slice(0, 10).join('\n'));
  await goHome();
});

/* ---------------- 12. Themes ---------------- */

await step(12, 'Both themes stay legible', async () => {
  await tab('home');
  await act('.appbar [data-action="toggle-theme"]');
  record('the toggle switched to light', (await page.getAttribute('html', 'data-theme')) === 'light');
  const contrast = await page.evaluate(async () => {
    const L = await import('./src/logic.js');
    const css = getComputedStyle(document.documentElement);
    const v = (n) => css.getPropertyValue(n).trim();
    const out = [];
    for (const t of ['--ink', '--muted', '--accent-text', '--positive-text', '--negative-text', '--warning-text']) {
      for (const bg of ['--surface', '--canvas', '--raised']) out.push([t, bg, L.contrastRatio(v(t), v(bg))]);
    }
    out.push(['--accent-ink', '--accent', L.contrastRatio(v('--accent-ink'), v('--accent'))]);
    return out;
  });
  const failing = contrast.filter(([, , r]) => r < 4.5);
  record('every text colour reaches AA in the light theme, as rendered', failing.length === 0,
    failing.map(([t, bg, r]) => `${t} on ${bg} ${r.toFixed(2)}`).join(', '));
  await page.screenshot({ path: path.join(SHOTS, '12-home-light.png') });
  await tab('insights');
  record('charts render in the light theme', (await page.locator('#view-insights svg.chart').count()) >= 4);
  await page.screenshot({ path: path.join(SHOTS, '12-insights-light.png'), fullPage: true });
  await act('.appbar [data-action="toggle-theme"]');
  record('and back to dark', (await page.getAttribute('html', 'data-theme')) === 'dark');
  await tab('home');
});

/* ---------------- A. Navigation and scrubbing ---------------- */

await step('A', 'The account screen, the back gesture and the crosshair', async () => {
  await openAccount('acc_lisa');
  record('the account screen hides the tab bar', await page.locator('#tabbar').isHidden());
  record('the add button steps aside on the goal tab', await page.locator('#fab').isHidden());
  await act('#view-account [data-action="account-tab"][data-tab="records"]');
  record('the records tab lists the entries', (await page.locator('#view-account [data-action="edit-tx"]').count()) > 5);
  record('the add button comes back on the records tab', await page.locator('#fab').isVisible());

  await page.goBack();
  await pause(300);
  record("the phone's back gesture returns to Home", await page.locator('#view-home').isVisible());

  await openAccount('acc_lisa');
  await act('#view-account [data-action="edit-account"]');
  await page.goBack();
  await pause(300);
  record('back closes an open form first, and stays on the account',
    (await page.locator('#sheet-backdrop').isHidden()) && (await page.locator('#view-account').isVisible()));
  await goHome();

  const chart = page.locator('#view-home .hero-chart svg');
  const box = await chart.boundingBox();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
  await pause(150);
  const readout = await page.locator('#view-home [data-readout]').innerText();
  record('moving along the line shows that day', /£[\d,]+\.\d\d on \d{1,2} \w+ \d{4}/.test(readout), readout);
  record('a crosshair marks the day', (await page.locator('#view-home .crosshair-group').getAttribute('visibility')) === 'visible');
  await page.mouse.move(box.x + box.width / 2, box.y - 60);
  await pause(150);
  record('it resets when the pointer leaves', /Net worth/.test(await page.locator('#view-home [data-readout]').innerText()));
});

/* ---------------- B. Offline ---------------- */

await step('B', 'The app works with the network disconnected', async () => {
  record('a service worker is in control', await page.evaluate(() => Boolean(navigator.serviceWorker.controller)));
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(900);
  record('the app loads and draws with no network', (await page.locator('#view-home .account-card').count()) >= 10);
  record('the data is still there offline', /£/.test(await heroValue()), await heroValue());

  const prices = () => page.evaluate(() => window.phthalo.app.state.accounts.filter((a) => a.type === 'quantity').map((a) => a.unitPricePence).join());
  const before = await prices();
  await act('.appbar [data-action="refresh-prices"]');
  await page.waitForTimeout(6500);
  record('a failed price refresh keeps every typed price', before === (await prices()));
  const notice = await page.locator('#banners').innerText();
  record('and says so without blocking anything', /left as they were/i.test(notice));
  record('the app is still fully usable', (await page.locator('#view-home .hero-chart svg').count()) === 1);
  await context.setOffline(false);
});

/* ---------------- C. Wide screen ---------------- */

await step('C', 'The layout widens gracefully', async () => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#view-home .account-card');
  record('no sideways scroll at 1024px on Home', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await page.screenshot({ path: path.join(SHOTS, 'C-home-1024.png') });
  await tab('insights');
  const columns = await page.evaluate(() => getComputedStyle(document.querySelector('.visual-list')).gridTemplateColumns.split(' ').length);
  record('Insights uses two columns on a wide screen', columns === 2, `${columns} columns`);
  await page.setViewportSize({ width: 375, height: 812 });
  await tab('home');
});

/* ---------------- D. In browser tests ---------------- */

await step('D', 'The in browser test page passes', async () => {
  const testPage = await context.newPage();
  const issues = [];
  testPage.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') issues.push(m.text()); });
  testPage.on('pageerror', (e) => issues.push(e.message));
  await testPage.goto(`${BASE}tests.html`, { waitUntil: 'networkidle' });
  await testPage.waitForFunction(() => !/Running/.test(document.getElementById('summary').textContent), { timeout: 40000 });
  const summary = await testPage.locator('#summary').innerText();
  record('tests.html reports every test passing', /All \d+ tests passed/.test(summary), summary);
  record('tests.html has a clean console', issues.length === 0, issues.join('\n'));
  await testPage.close();
});

/* ---------------- E. Storage failure modes ---------------- */

await step('E', 'The three storage failure modes, and an old saved file', async () => {
  const corrupt = await context.newPage();
  await corrupt.goto(BASE, { waitUntil: 'networkidle' });
  await corrupt.evaluate(() => {
    localStorage.setItem('phthalo.finance.v1', '{ this is not json');
    localStorage.removeItem('phthalo.finance.v1.backup');
  });
  await corrupt.reload({ waitUntil: 'networkidle' });
  record('corrupt data shows a banner, not a blank screen', /could not be read/i.test(await corrupt.locator('#banners').innerText()));
  record('and offers the damaged file', (await corrupt.locator('[data-action="export-damaged"]').count()) === 1);
  record('and the app still runs', (await corrupt.locator('#view-home .account-card').count()) >= 1);
  record('nothing was silently deleted', (await corrupt.evaluate(() => localStorage.getItem('phthalo.finance.v1'))) !== null);
  await corrupt.evaluate(() => {
    localStorage.setItem('phthalo.finance.v1.backup', JSON.stringify({
      schemaVersion: 1, accounts: [{ id: 'a', name: 'Rescued', type: 'balance', category: 'Cash' }],
      transactions: [{ id: 't', accountId: 'a', date: '2026-01-01', direction: 'in', amountPence: 4200 }]
    }));
    localStorage.setItem('phthalo.finance.v1', 'half a written {');
  });
  await corrupt.reload({ waitUntil: 'networkidle' });
  record('a damaged main copy falls back to the rolling backup', /rolling backup/i.test(await corrupt.locator('#banners').innerText()));
  record('and the backup really loads', await corrupt.evaluate(() => window.phthalo.app.state.accounts.some((a) => a.name === 'Rescued')));
  await corrupt.close();

  const off = await browser.newContext({ viewport: { width: 375, height: 812 } });
  await off.addInitScript(() => {
    const blow = () => { const e = new Error('denied'); e.name = 'SecurityError'; throw e; };
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { return { getItem: blow, setItem: blow, removeItem: blow, clear: blow, key: blow, length: 0 }; } });
  });
  const noStore = await off.newPage();
  const thrown = [];
  noStore.on('pageerror', (e) => thrown.push(e.message));
  await noStore.goto(BASE, { waitUntil: 'networkidle' });
  record('storage switched off shows a clear warning', /will not let the app save/i.test(await noStore.locator('#banners').innerText()));
  record('and the app runs without throwing', thrown.length === 0 && (await noStore.locator('#view-home .account-card').count()) >= 1, thrown.join('; '));
  await off.close();

  const full = await browser.newContext({ viewport: { width: 375, height: 812 } });
  await full.addInitScript(() => {
    const real = window.localStorage.setItem.bind(window.localStorage);
    let armed = false;
    window.__armQuota = () => { armed = true; };
    window.localStorage.setItem = function setItem(k, v) {
      if (armed && k.startsWith('phthalo.finance.v1')) { const e = new Error('quota'); e.name = 'QuotaExceededError'; e.code = 22; throw e; }
      return real(k, v);
    };
  });
  const fp = await full.newPage();
  await fp.goto(BASE, { waitUntil: 'networkidle' });
  await fp.evaluate(() => window.__armQuota());
  await fp.click('#view-home [data-action="open-account"][data-arg="acc_savings"]');
  await fp.click('#view-account .quick-actions [data-action="new-tx"][data-dir="in"]');
  await fp.fill('#tx-amount', '25');
  await fp.click('form[data-form="transaction"] button[type="submit"]');
  await fp.waitForTimeout(400);
  record('a full quota is reported, not swallowed', /run out of storage/i.test(await fp.locator('#banners').innerText()));
  record('with a backup download offered', (await fp.locator('#banners [data-action="export-json"]').count()) === 1);
  record('and the change is still on screen', /25\.00/.test(await fp.locator('#view-account .stat-big').innerText()));
  await full.close();

  const old = await context.newPage();
  await old.goto(BASE, { waitUntil: 'networkidle' });
  await old.evaluate(() => {
    localStorage.setItem('phthalo.finance.v1', JSON.stringify({
      accounts: [
        { id: 'sav', name: 'Old savings', type: 'balance', category: 'Cash', goalTarget: 10000, goalDate: '2027-01-01' },
        { id: 'btc', name: 'Old bitcoin', units: 0.5, unit: 'BTC', unitPrice: 42000.5, category: 'Crypto' }
      ],
      transactions: [
        { id: 't1', accountId: 'sav', date: '2026-01-01', amount: 1234.56 },
        { id: 't2', accountId: 'sav', date: '2026-02-01', amount: -34.56 }
      ],
      visuals: [{ id: 'netWorth', enabled: true }, { id: 'goals', enabled: true }]
    }));
    localStorage.removeItem('phthalo.finance.v1.backup');
  });
  await old.reload({ waitUntil: 'networkidle' });
  record('an old saved file is upgraded with a note', /upgraded/i.test(await old.locator('#banners').innerText()));
  const m = await old.evaluate(() => {
    const s = window.phthalo.app.state;
    return {
      pence: s.transactions.find((t) => t.id === 't1').amountPence,
      dir: s.transactions.find((t) => t.id === 't2').direction,
      goal: s.accounts.find((a) => a.id === 'sav').goal.targetPence,
      type: s.accounts.find((a) => a.id === 'btc').type,
      netWorthVisual: s.visuals.some((v) => v.id === 'netWorth')
    };
  });
  record('pounds became integer pence, the withdrawal and goal survived',
    m.pence === 123456 && m.dir === 'out' && m.goal === 1000000 && m.type === 'quantity', JSON.stringify(m));
  record('the old net worth chart entry was dropped cleanly', m.netWorthVisual === false);
  await old.close();
});

/* ---------------- F. One account, and the wording ---------------- */

await step('F', 'Every chart with exactly one account, and the interface wording', async () => {
  const solo = await context.newPage();
  await solo.goto(BASE, { waitUntil: 'networkidle' });
  await solo.evaluate(() => {
    localStorage.setItem('phthalo.finance.v1', JSON.stringify({
      schemaVersion: 1,
      accounts: [{ id: 'only', name: 'Savings account', type: 'balance', category: 'Cash', order: 0, archived: false, note: '',
        goal: { targetPence: 500000, targetDate: '2027-06-01', startDate: '2026-01-01', startPence: 0 } }],
      transactions: [
        { id: 'x1', accountId: 'only', date: '2026-03-01', direction: 'in', amountPence: 120000 },
        { id: 'x2', accountId: 'only', date: '2026-07-01', direction: 'in', amountPence: 80000 }
      ],
      visuals: ['position', 'allocation', 'goals', 'contributions', 'monthlyNet', 'holdings', 'categoryTotals'].map((id, i) => ({ id, enabled: true, order: i }))
    }));
  });
  await solo.reload({ waitUntil: 'networkidle' });
  record('net worth is right with one account', (await solo.locator('#hero-value').innerText()) === '£2,000.00');
  await solo.click('.tabbar button[data-view="insights"]');
  await solo.waitForTimeout(300);
  record('all seven charts render', (await solo.locator('#view-insights [data-visual-id]').count()) === 7);
  record('none errors or is blank', (await solo.locator('#view-insights .chart-error, #view-insights .card-body:empty').count()) === 0);
  const titles = await solo.locator('#view-insights .card-title').allInnerTexts();
  record('every card has a plain English title', titles.every((t) => t.length > 8), titles.join(' | '));
  await solo.screenshot({ path: path.join(SHOTS, 'F-single-account.png'), fullPage: true });

  const prose = await solo.evaluate(() => {
    const seen = new Set();
    for (const view of ['home', 'insights']) {
      document.querySelectorAll(`#view-${view}, .appbar, .tabbar, .banner`).forEach((root) => {
        root.querySelectorAll('*').forEach((el) => el.childNodes.forEach((n) => { if (n.nodeType === 3 && n.textContent.trim()) seen.add(n.textContent.trim()); }));
      });
    }
    return [...seen];
  });
  record('no em or en dashes in the interface', !prose.some((t) => /[–—]/.test(t)));
  const hyphenated = prose.filter((t) => /[A-Za-z]{2,}-[A-Za-z]{2,}/.test(t));
  record('no hyphenated words in the interface', hyphenated.length === 0, hyphenated.join(' | '));
  await solo.close();
});

/* ---------------- 13. Console ---------------- */

await step(13, 'The browser console is clean throughout', async () => {
  // Chromium logs its own line for a request that fails while offline.
  // That comes from the browser, not the app, and no page can suppress it.
  const unavoidable = consoleIssues.filter((c) => /disconnected/i.test(c.step) && /ERR_INTERNET_DISCONNECTED|Failed to fetch/.test(c.text));
  const real = consoleIssues.filter((c) => !unavoidable.includes(c));
  record('no console errors or warnings during normal use', real.length === 0,
    real.map((c) => `[${c.step}] ${c.type}: ${c.text}`).join('\n'));
  if (unavoidable.length) {
    console.log(`  NOTE  ${unavoidable.length} browser level network line(s) during the deliberate offline test. `
      + 'They come from Chromium itself; the app caught every one and carried on.');
  }
});

await browser.close();
server.kill();

const failed = results.filter((r) => !r.ok);
console.log(`\n${'='.repeat(64)}\n${results.length - failed.length} of ${results.length} checks passed`);
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`);
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? `\n      ${String(f.detail).replace(/\n/g, '\n      ')}` : ''}`);
}
console.log('='.repeat(64));
process.exit(failed.length ? 1 : 0);
