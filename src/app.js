/**
 * app.js
 *
 * All of the DOM work. Every number on screen comes from a pure function
 * in logic.js; nothing is calculated here.
 */

import {
  CATEGORIES,
  VISUAL_LIBRARY,
  activeAccounts,
  addDays,
  balancesAt,
  checkWithdrawal,
  dateToISO,
  describeTimeRemaining,
  formatMoney,
  formatUnits,
  goalProgress,
  isValidISODate,
  netWorthAt,
  parseMoneyToPence,
  parseUnitsToE8,
  projectPayoff,
  averageMonthlyRepayment,
  quantityValuePence,
  sortedTransactions,
  transactionsToCsv,
  unitsForPence,
  assignAccountColours
} from './logic.js';

import { renderVisual, esc, seriesVar } from './charts.js';
import { demoState, emptyStateWithDefaults } from './seed.js';
import * as store from './storage.js';
import { fetchPrices, describeResult } from './prices.js';

/* ------------------------------------------------------------------ */
/* Global safety net, installed before anything else can run           */
/* ------------------------------------------------------------------ */

let recoveryShown = false;

function showRecovery(what, detail) {
  if (recoveryShown) return;
  recoveryShown = true;
  try {
    const screen = document.getElementById('recovery');
    const message = document.getElementById('recovery-message');
    const pre = document.getElementById('recovery-detail');
    if (message) {
      message.textContent = `${what} Your saved data has not been touched. `
        + 'Export a copy before you do anything else, then reload the page.';
    }
    if (pre) pre.textContent = String(detail || '').slice(0, 4000);
    if (screen) screen.hidden = false;
  } catch {
    // If even this fails there is nothing sensible left to do.
  }
}

window.addEventListener('error', (event) => {
  showRecovery('The app hit an unexpected problem.',
    `${event.message}\n${event.filename}:${event.lineno}\n${event.error && event.error.stack ? event.error.stack : ''}`);
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  showRecovery('A background task failed unexpectedly.',
    reason && reason.stack ? reason.stack : String(reason));
});

/* ------------------------------------------------------------------ */
/* Application state                                                   */
/* ------------------------------------------------------------------ */

const app = {
  state: null,
  view: 'home',
  banners: [],
  bannerSeq: 0,
  saveBlocked: false,
  lastWidth: 0,
  pendingConfirm: null
};

const todayISO = () => dateToISO(new Date());

function byId(id) { return document.getElementById(id); }

function nextId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/* ------------------------------------------------------------------ */
/* Banners                                                             */
/* ------------------------------------------------------------------ */

function addBanner({ kind = 'info', title, body, actions = [], key = null, dismissible = true }) {
  if (key && app.banners.some((b) => b.key === key)) return;
  app.bannerSeq += 1;
  app.banners.push({ id: `banner_${app.bannerSeq}`, kind, title, body, actions, key, dismissible });
  renderBanners();
}

function removeBanner(id) {
  app.banners = app.banners.filter((b) => b.id !== id);
  renderBanners();
}

function renderBanners() {
  const host = byId('banners');
  if (!host) return;
  host.innerHTML = app.banners.map((banner) => `
    <div class="banner is-${esc(banner.kind)}" data-banner="${esc(banner.id)}">
      <div>
        <p class="banner-title">${esc(banner.title)}</p>
        <p class="banner-body">${esc(banner.body)}</p>
      </div>
      <div class="banner-actions">
        ${banner.actions.map((action) => `
          <button type="button" class="button is-small${action.primary ? ' is-primary' : ''}"
                  data-action="${esc(action.action)}"
                  ${action.arg ? `data-arg="${esc(action.arg)}"` : ''}>${esc(action.label)}</button>`).join('')}
        ${banner.dismissible ? `<button type="button" class="button is-small is-quiet"
            data-action="dismiss-banner" data-arg="${esc(banner.id)}">Dismiss</button>` : ''}
      </div>
    </div>`).join('');
}

/* ------------------------------------------------------------------ */
/* Saving                                                              */
/* ------------------------------------------------------------------ */

/** Apply a change, autosave, and redraw. The only way state ever moves. */
function commit(mutator, options = {}) {
  try {
    const draft = JSON.parse(JSON.stringify(app.state));
    const result = mutator(draft);
    const next = result === undefined ? draft : result;
    next.updatedAt = new Date().toISOString();
    app.state = next;
  } catch (error) {
    addBanner({
      kind: 'error',
      title: 'That change could not be applied',
      body: `${error.message}. Nothing was saved, so your data is as it was.`
    });
    return false;
  }

  const saved = store.save(app.state);
  if (!saved.ok) {
    if (!app.saveBlocked) {
      app.saveBlocked = true;
      addBanner({
        kind: 'error',
        key: `save-${saved.reason}`,
        title: 'Your change was not saved',
        body: saved.message,
        actions: [{ label: 'Download a backup', action: 'export-json', primary: true }],
        dismissible: false
      });
    }
  } else {
    if (app.saveBlocked) {
      app.saveBlocked = false;
      app.banners = app.banners.filter((b) => !String(b.key || '').startsWith('save-'));
    }
    if (saved.reason === 'quota-recovered') {
      addBanner({ kind: 'info', key: 'quota-recovered', title: 'Storage was full', body: saved.message });
    }
  }

  if (options.silent !== true) render();
  return true;
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

function boot() {
  const today = todayISO();
  const loaded = store.load(today);

  if (loaded.status === store.STATUS.FIRST_RUN) {
    app.state = emptyStateWithDefaults(today);
    store.save(app.state);
    addBanner({
      kind: 'info',
      key: 'welcome',
      title: 'Welcome. Everything stays on this device',
      body: 'Nothing is sent anywhere and there is no account to create. Tap "Load demo data" '
        + 'on the Data tab to see every chart working, or start adding your own money straight away.'
    });
  } else if (loaded.status === store.STATUS.DISABLED) {
    app.state = emptyStateWithDefaults(today);
    app.saveBlocked = true;
    addBanner({
      kind: 'error',
      key: 'storage-disabled',
      title: 'This browser will not let the app save',
      body: loaded.message,
      actions: [{ label: 'Download a backup', action: 'export-json', primary: true }],
      dismissible: false
    });
  } else if (loaded.status === store.STATUS.CORRUPT) {
    app.state = emptyStateWithDefaults(today);
    addBanner({
      kind: 'error',
      key: 'corrupt',
      title: 'The saved data could not be read',
      body: loaded.message,
      actions: [{ label: 'Download the damaged file', action: 'export-damaged', primary: true }],
      dismissible: false
    });
  } else {
    app.state = loaded.state;
    if (loaded.status === store.STATUS.RECOVERED) {
      addBanner({
        kind: 'error',
        key: 'recovered',
        title: 'Loaded from the rolling backup',
        body: loaded.message,
        actions: [{ label: 'Export a backup now', action: 'export-json', primary: true }]
      });
    } else if (loaded.status === store.STATUS.MIGRATED) {
      addBanner({ kind: 'info', key: 'migrated', title: 'Saved data upgraded', body: loaded.message });
    }
  }

  // A phone specific warning that is genuinely worth showing once.
  if (!app.state.settings.notices.iosStorage && isIosSafariNotInstalled()) {
    addBanner({
      kind: 'info',
      key: 'ios-storage',
      title: 'Add this to your home screen to keep your data',
      body: 'iOS Safari can clear the storage of a website you have not opened for a few weeks. '
        + 'Adding Phthalo Finance to your home screen stops that happening. Tap Share, then '
        + '"Add to Home Screen".',
      actions: [{ label: 'Got it', action: 'dismiss-ios-notice', primary: true }],
      dismissible: false
    });
  }

  checkBackupReminder();
  render();
  registerServiceWorker();
  watchSystemTheme();
}

function isIosSafariNotInstalled() {
  const ua = navigator.userAgent || '';
  const isIos = /iPad|iPhone|iPod/.test(ua)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.navigator.standalone === true
    || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  return isIos && !standalone;
}

function checkBackupReminder() {
  const days = store.daysSinceExport(app.state, todayISO());
  const hasData = app.state.transactions.length > 0;
  if (!hasData) return;
  if (days === null || days >= 30) {
    addBanner({
      kind: 'info',
      key: 'backup-reminder',
      title: days === null ? 'You have never exported a backup' : `Your last backup was ${days} days ago`,
      body: 'A backup is a single file you can keep anywhere. It takes a second and it is the only '
        + 'thing standing between a cleared browser and starting again.',
      actions: [{ label: 'Export now', action: 'export-json', primary: true }]
    });
  }
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function render() {
  try {
    for (const view of ['home', 'accounts', 'activity', 'data']) {
      const el = byId(`view-${view}`);
      if (el) el.hidden = view !== app.view;
    }
    document.querySelectorAll('.tabbar button[data-view]').forEach((button) => {
      if (button.dataset.view === app.view) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });

    if (app.view === 'home') renderHome();
    else if (app.view === 'accounts') renderAccounts();
    else if (app.view === 'activity') renderActivity();
    else if (app.view === 'data') renderData();
  } catch (error) {
    showRecovery('The screen could not be drawn.', error && error.stack ? error.stack : String(error));
  }
}

function renderHome() {
  const host = byId('view-home');
  const enabled = app.state.visuals.filter((v) => v.enabled);

  if (!enabled.length) {
    host.innerHTML = `
      <div class="section-head"><h2 class="section-title">Home</h2>
        <button type="button" class="button is-small" data-action="open-gallery">Add a visual</button></div>
      <p class="empty-note">Every visual is switched off. Open the gallery to put some back.</p>`;
    return;
  }

  host.innerHTML = `
    <div class="visual-list">
      ${enabled.map((visual, index) => {
    const meta = VISUAL_LIBRARY[visual.id] || { name: visual.id };
    return `
        <article class="card${visual.id === 'netWorth' ? ' is-wide' : ''}" data-visual-id="${esc(visual.id)}">
          <div class="card-head">
            <div>
              <h2 class="card-title">${esc(meta.name)}</h2>
              <p class="card-subtitle">${esc(meta.name)}</p>
            </div>
            <div class="card-tools">
              <button type="button" class="button is-icon is-quiet" data-action="move-visual"
                      data-arg="${esc(visual.id)}" data-dir="up" ${index === 0 ? 'disabled' : ''}
                      aria-label="Move ${esc(meta.name)} up">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
                     stroke-width="2" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"
                     stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
              <button type="button" class="button is-icon is-quiet" data-action="move-visual"
                      data-arg="${esc(visual.id)}" data-dir="down"
                      ${index === enabled.length - 1 ? 'disabled' : ''}
                      aria-label="Move ${esc(meta.name)} down">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
                     stroke-width="2" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6"
                     stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
              <button type="button" class="button is-icon is-quiet" data-action="hide-visual"
                      data-arg="${esc(visual.id)}" aria-label="Remove ${esc(meta.name)} from the home screen">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
                     stroke-width="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"
                     stroke-linecap="round"/></svg>
              </button>
            </div>
          </div>
          <div class="card-body"></div>
        </article>`;
  }).join('')}
    </div>
    <div class="section-head">
      <button type="button" class="button" data-action="open-gallery" style="width:100%">
        Add or remove visuals
      </button>
    </div>`;

  // Second pass: measure each card and draw at real pixel size.
  const today = todayISO();
  host.querySelectorAll('[data-visual-id]').forEach((card) => {
    const id = card.dataset.visualId;
    const body = card.querySelector('.card-body');
    const width = Math.max(240, Math.floor(body.clientWidth || card.clientWidth - 28));
    const result = renderVisual(id, { state: app.state, today, width });
    const titleEl = card.querySelector('.card-title');
    const subtitleEl = card.querySelector('.card-subtitle');
    titleEl.textContent = result.title;
    subtitleEl.textContent = (VISUAL_LIBRARY[id] || {}).name || id;
    body.innerHTML = result.body;
  });
  app.lastWidth = window.innerWidth;
}

function renderAccounts() {
  const host = byId('view-accounts');
  const today = todayISO();
  const balances = balancesAt(app.state, today);
  const accounts = activeAccounts(app.state);
  const archived = app.state.accounts.filter((a) => a.archived);
  const totals = netWorthAt(app.state, today);

  const rowFor = (account) => {
    const entry = balances.get(account.id) || { valuePence: 0, unitsE8: 0, pricePence: 0 };
    const isDebt = account.type === 'liability';
    const meta = [account.category];
    if (account.type === 'quantity') {
      meta.push(`${formatUnits(entry.unitsE8, 6)} ${account.unit || 'units'} at ${formatMoney(entry.pricePence)}`);
    }
    if (account.goal) meta.push('has a goal');
    return `
      <li>
        <button type="button" class="row" data-action="open-account" data-arg="${esc(account.id)}">
          <span class="row-stripe" style="background:${isDebt ? 'var(--negative)' : seriesVar(account.colourIndex)}"></span>
          <span class="row-main">
            <span class="row-name">${esc(account.name)}</span>
            <span class="row-meta">${esc(meta.join(' · '))}</span>
          </span>
          <span class="row-value${isDebt ? ' is-negative' : ''}">
            ${esc(formatMoney(isDebt ? -entry.valuePence : entry.valuePence))}
          </span>
        </button>
      </li>`;
  };

  host.innerHTML = `
    <div class="section-head">
      <h2 class="section-title">Accounts</h2>
      <button type="button" class="button is-small is-primary" data-action="add-account">Add account</button>
    </div>
    <div class="card" style="margin-bottom:14px">
      <p class="hero-label">Net worth</p>
      <p class="hero-value">${esc(formatMoney(totals.netWorthPence))}</p>
      <p class="card-subtitle">${esc(formatMoney(totals.assetsPence))} in assets less
        ${esc(formatMoney(totals.liabilitiesPence))} owed</p>
    </div>
    ${accounts.length
    ? `<ul class="row-list">${accounts.map((a) => rowFor(a)).join('')}</ul>
       <p class="section-hint" style="margin-top:10px">Open an account to reorder, archive,
         rename or delete it.</p>`
    : '<p class="empty-note">No accounts yet. Add one to get started.</p>'}
    ${archived.length ? `
      <div class="section-head"><h3 class="section-title">Archived</h3></div>
      <p class="section-hint">Archived accounts keep their history but are left out of your totals.</p>
      <ul class="row-list">
        ${archived.map((account) => `
          <li><button type="button" class="row is-archived" data-action="open-account" data-arg="${esc(account.id)}">
            <span class="row-stripe" style="background:var(--muted)"></span>
            <span class="row-main"><span class="row-name">${esc(account.name)}</span>
              <span class="row-meta">Archived</span></span>
            <span class="row-value">-</span>
          </button></li>`).join('')}
      </ul>` : ''}`;
}

function renderActivity() {
  const host = byId('view-activity');
  const accounts = new Map(app.state.accounts.map((a) => [a.id, a]));
  const txs = sortedTransactions(app.state).slice().reverse();

  if (!txs.length) {
    host.innerHTML = `
      <div class="section-head"><h2 class="section-title">Activity</h2></div>
      <p class="empty-note">Nothing recorded yet. Open an account and add some money.</p>`;
    return;
  }

  const groups = new Map();
  for (const tx of txs.slice(0, 400)) {
    if (!groups.has(tx.date)) groups.set(tx.date, []);
    groups.get(tx.date).push(tx);
  }

  host.innerHTML = `
    <div class="section-head">
      <h2 class="section-title">Activity</h2>
      <span class="card-subtitle">${txs.length} entr${txs.length === 1 ? 'y' : 'ies'}</span>
    </div>
    ${txs.length > 400 ? '<p class="section-hint">Showing the most recent 400 entries.</p>' : ''}
    ${Array.from(groups.entries()).map(([date, list]) => `
      <div class="section-head" style="margin:14px 0 8px">
        <h3 class="section-title" style="font-size:13.5px;color:var(--muted)">${esc(longDate(date))}</h3>
      </div>
      <ul class="row-list">
        ${list.map((tx) => {
    const account = accounts.get(tx.accountId);
    const out = tx.direction === 'out';
    const detail = [];
    if (tx.unitsE8) detail.push(`${formatUnits(tx.unitsE8, 6)} ${account && account.unit ? account.unit : 'units'}`);
    if (tx.note) detail.push(tx.note);
    return `
          <li><button type="button" class="row" data-action="edit-tx" data-arg="${esc(tx.id)}">
            <span class="row-stripe" style="background:${account && account.type === 'liability'
      ? 'var(--negative)' : seriesVar(account ? account.colourIndex : 5)}"></span>
            <span class="row-main">
              <span class="row-name">${esc(account ? account.name : 'Deleted account')}</span>
              <span class="row-meta">${esc(detail.join(' · ') || (out ? 'Money out' : 'Money in'))}</span>
            </span>
            <span class="row-value${out ? ' is-negative' : ''}">
              ${esc(formatMoney(out ? -tx.amountPence : tx.amountPence, { showSign: true }))}
            </span>
          </button></li>`;
  }).join('')}
      </ul>`).join('')}`;
}

function renderData() {
  const host = byId('view-data');
  const days = store.daysSinceExport(app.state, todayISO());
  const theme = app.state.settings.theme || 'system';
  const counts = {
    accounts: app.state.accounts.length,
    transactions: app.state.transactions.length
  };

  host.innerHTML = `
    <div class="section-head"><h2 class="section-title">Your data</h2></div>
    <div class="card" style="display:grid;gap:12px">
      <p class="card-subtitle">${counts.accounts} accounts and ${counts.transactions} entries are stored
        in this browser only. ${days === null ? 'You have never exported a backup.'
    : `Last exported ${days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} ago`}.`}</p>
      <div class="banner-actions">
        <button type="button" class="button is-primary" data-action="export-json">Export to JSON</button>
        <button type="button" class="button" data-action="export-csv">Export to CSV</button>
        <button type="button" class="button" data-action="import-json">Import from JSON</button>
      </div>
      <p class="field-hint">The JSON file is a complete backup you can import again later.
        The CSV file lists every transaction for opening in a spreadsheet.</p>
    </div>

    <div class="section-head"><h3 class="section-title">Appearance</h3></div>
    <div class="card">
      <div class="field">
        <label for="theme-select">Theme</label>
        <select class="select" id="theme-select" data-action="set-theme">
          <option value="system"${theme === 'system' ? ' selected' : ''}>Follow the system</option>
          <option value="dark"${theme === 'dark' ? ' selected' : ''}>Always dark</option>
          <option value="light"${theme === 'light' ? ' selected' : ''}>Always light</option>
        </select>
        <p class="field-hint">Dark is used when the system has no preference.</p>
      </div>
    </div>

    <div class="section-head"><h3 class="section-title">Sample data</h3></div>
    <div class="card" style="display:grid;gap:12px">
      <p class="card-subtitle">The demo fills the app with twelve months of realistic activity so you
        can see every chart working. It replaces whatever is there now.</p>
      <div class="banner-actions">
        <button type="button" class="button" data-action="load-demo">Load demo data</button>
        <button type="button" class="button is-danger" data-action="clear-all">Clear all data</button>
      </div>
    </div>

    <div class="section-head"><h3 class="section-title">Prices</h3></div>
    <div class="card" style="display:grid;gap:12px">
      <p class="card-subtitle">Unit prices are yours to type in. The refresh button tries a free public
        price service and quietly keeps your last manual price if anything at all goes wrong.</p>
      <div class="banner-actions">
        <button type="button" class="button" data-action="refresh-prices">Refresh prices now</button>
      </div>
    </div>

    <div class="section-head"><h3 class="section-title">About</h3></div>
    <div class="card">
      <p class="card-subtitle">Phthalo Finance stores everything in this browser under a single key.
        Nothing is uploaded and there is no account. If you clear your browser data, or iOS clears it
        for you, an exported backup is the only way back, so export one now and then.</p>
    </div>`;
}

function longDate(iso) {
  const names = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  const parts = String(iso).split('-');
  return `${Number(parts[2])} ${names[Number(parts[1]) - 1]} ${parts[0]}`;
}

/* ------------------------------------------------------------------ */
/* Sheet                                                               */
/* ------------------------------------------------------------------ */

let lastFocus = null;

function openSheet(title, html) {
  lastFocus = document.activeElement;
  const sheet = byId('sheet');
  sheet.innerHTML = `
    <div class="sheet-head">
      <h2 class="sheet-title" id="sheet-title">${esc(title)}</h2>
      <button type="button" class="button is-icon is-quiet" data-action="close-sheet" aria-label="Close">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
             stroke-width="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round"/></svg>
      </button>
    </div>
    ${html}`;
  byId('sheet-backdrop').hidden = false;
  const focusable = sheet.querySelector('input, select, textarea, button:not([data-action="close-sheet"])');
  if (focusable) focusable.focus();
  sheet.scrollTop = 0;
}

function closeSheet() {
  byId('sheet-backdrop').hidden = true;
  byId('sheet').innerHTML = '';
  if (lastFocus && document.body.contains(lastFocus)) lastFocus.focus();
  lastFocus = null;
}

function confirmSheet({ title, body, confirmLabel, danger = false, extraAction = null, onConfirm }) {
  app.pendingConfirm = onConfirm;
  openSheet(title, `
    <p style="font-size:15px;color:var(--muted);margin-bottom:16px">${esc(body)}</p>
    ${extraAction ? `<div class="banner-actions" style="margin-bottom:12px">
      <button type="button" class="button" data-action="${esc(extraAction.action)}">${esc(extraAction.label)}</button>
    </div>` : ''}
    <div class="form-actions">
      <button type="button" class="button" data-action="close-sheet">Cancel</button>
      <button type="button" class="button ${danger ? 'is-danger' : 'is-primary'}"
              data-action="run-confirm">${esc(confirmLabel)}</button>
    </div>`);
}

/* ------------------------------------------------------------------ */
/* Account detail and forms                                            */
/* ------------------------------------------------------------------ */

function accountById(id) {
  return app.state.accounts.find((a) => a.id === id) || null;
}

function openAccount(id) {
  const account = accountById(id);
  if (!account) return;
  const today = todayISO();
  const entry = balancesAt(app.state, today).get(account.id)
    || { valuePence: 0, unitsE8: 0, pricePence: 0 };
  const isDebt = account.type === 'liability';
  const isQuantity = account.type === 'quantity';
  const txs = sortedTransactions(app.state).filter((t) => t.accountId === account.id).reverse();

  const progress = account.goal ? goalProgress(account, entry.valuePence, today) : null;
  const ordered = activeAccounts(app.state);
  const position = ordered.findIndex((a) => a.id === account.id);
  const isFirst = position <= 0;
  const isLast = position === -1 || position === ordered.length - 1;

  let payoff = '';
  if (isDebt && entry.valuePence > 0) {
    const monthly = averageMonthlyRepayment(app.state, account.id, { today, windowMonths: 6 });
    const projection = projectPayoff(entry.valuePence, monthly, account.interestRatePct || 0, today);
    payoff = `
      <div class="card" style="margin-bottom:14px">
        <p class="card-subtitle" style="margin-bottom:6px">Payoff projection</p>
        ${projection.months === null
    ? `<p style="font-size:14.5px">No payoff date can be worked out: ${esc(projection.reason)}.
         ${monthly > 0 ? `You are paying about ${esc(formatMoney(monthly))} a month.` : ''}</p>`
    : `<p style="font-size:14.5px">At ${esc(formatMoney(monthly))} a month
         ${account.interestRatePct ? `and ${esc(account.interestRatePct)}% interest` : 'with no interest'},
         this clears in ${projection.months} month${projection.months === 1 ? '' : 's'},
         around ${esc(longDate(projection.payoffDate))}.
         ${projection.totalInterestPence ? `That includes about ${esc(formatMoney(projection.totalInterestPence))} of interest.` : ''}</p>`}
      </div>`;
  }

  const goalBlock = progress ? `
    <div class="card" style="margin-bottom:14px">
      <p class="card-subtitle" style="margin-bottom:6px">Goal</p>
      <p style="font-size:15px;font-weight:650">${esc(Math.round(progress.percent))}% reached${progress.exceeded
    ? ` (${Math.round(progress.rawPercent)}% of the target)` : ''}</p>
      <p style="font-size:14px;color:var(--muted)">
        ${progress.remainingPence > 0
    ? `${esc(formatMoney(progress.remainingPence))} still needed`
    : 'Target reached'}${progress.targetDate
    ? `, ${esc(progress.overdue ? `target date passed ${describeTimeRemaining(progress.timeRemaining)}`
      : describeTimeRemaining(progress.timeRemaining) + ' left')}` : ''}.
      </p>
      <div class="banner-actions" style="margin-top:10px">
        <button type="button" class="button is-small" data-action="edit-goal" data-arg="${esc(account.id)}">Edit goal</button>
        <button type="button" class="button is-small is-quiet" data-action="clear-goal" data-arg="${esc(account.id)}">Remove goal</button>
      </div>
    </div>`
    : `<div class="banner-actions" style="margin-bottom:14px">
        <button type="button" class="button is-small" data-action="edit-goal" data-arg="${esc(account.id)}">Set a goal</button>
      </div>`;

  openSheet(account.name, `
    <div class="card" style="margin-bottom:14px">
      <p class="hero-label">${esc(isDebt ? 'Owed' : 'Value')}</p>
      <p class="hero-value">${esc(formatMoney(isDebt ? -entry.valuePence : entry.valuePence))}</p>
      <p class="card-subtitle">${esc(account.category)}${isQuantity
    ? ` · ${esc(formatUnits(entry.unitsE8, 8))} ${esc(account.unit || 'units')} at ${esc(formatMoney(entry.pricePence))}`
    : ''}${account.archived ? ' · archived' : ''}</p>
    </div>

    <div class="banner-actions" style="margin-bottom:14px">
      <button type="button" class="button is-primary" data-action="new-tx" data-arg="${esc(account.id)}"
              data-dir="in">${esc(isDebt ? 'Add to debt' : 'Add money')}</button>
      <button type="button" class="button" data-action="new-tx" data-arg="${esc(account.id)}"
              data-dir="out">${esc(isDebt ? 'Make a payment' : 'Withdraw money')}</button>
    </div>

    ${isQuantity ? `
      <div class="card" style="margin-bottom:14px">
        <p class="card-subtitle" style="margin-bottom:8px">Unit price</p>
        <div class="field-row">
          <div class="field" style="margin:0">
            <label for="unit-price">Price per ${esc(account.unit || 'unit')}</label>
            <input class="input" id="unit-price" type="text" inputmode="decimal"
                   value="${esc((account.unitPricePence / 100).toFixed(2))}">
          </div>
          <div style="display:flex;align-items:flex-end">
            <button type="button" class="button is-primary" data-action="save-price"
                    data-arg="${esc(account.id)}" style="width:100%">Save price</button>
          </div>
        </div>
        <p class="field-hint" id="price-hint">${account.priceUpdatedAt
    ? `Last updated ${esc(longDate(account.priceUpdatedAt))} (${esc(account.priceSource || 'manual')}).`
    : 'Never updated. Type the price you paid or the price today.'}</p>
      </div>` : ''}

    ${goalBlock}
    ${payoff}

    <div class="section-head"><h3 class="section-title">History</h3></div>
    ${txs.length ? `<ul class="row-list">${txs.slice(0, 60).map((tx) => `
      <li><button type="button" class="row" data-action="edit-tx" data-arg="${esc(tx.id)}">
        <span class="row-stripe" style="background:${tx.direction === 'out'
    ? 'var(--negative)' : 'var(--positive)'}"></span>
        <span class="row-main">
          <span class="row-name">${esc(longDate(tx.date))}</span>
          <span class="row-meta">${esc([tx.unitsE8 ? `${formatUnits(tx.unitsE8, 6)} ${account.unit || 'units'}` : '',
    tx.note].filter(Boolean).join(' · ') || (tx.direction === 'out' ? 'Money out' : 'Money in'))}</span>
        </span>
        <span class="row-value${tx.direction === 'out' ? ' is-negative' : ''}">
          ${esc(formatMoney(tx.direction === 'out' ? -tx.amountPence : tx.amountPence, { showSign: true }))}
        </span>
      </button></li>`).join('')}</ul>`
    : '<p class="empty-note">No entries for this account yet.</p>'}

    <div class="form-actions">
      <button type="button" class="button" data-action="move-account" data-arg="${esc(account.id)}"
              data-dir="up" ${isFirst ? 'disabled' : ''}>Move up</button>
      <button type="button" class="button" data-action="move-account" data-arg="${esc(account.id)}"
              data-dir="down" ${isLast ? 'disabled' : ''}>Move down</button>
    </div>
    <div class="form-actions">
      <button type="button" class="button" data-action="edit-account" data-arg="${esc(account.id)}">Edit account</button>
      <button type="button" class="button" data-action="toggle-archive" data-arg="${esc(account.id)}">
        ${account.archived ? 'Restore' : 'Archive'}</button>
    </div>
    <div class="form-actions">
      <button type="button" class="button is-danger" data-action="delete-account"
              data-arg="${esc(account.id)}" style="width:100%">Delete this account</button>
    </div>`);
}

function accountForm(accountId) {
  const existing = accountId ? accountById(accountId) : null;
  const a = existing || {
    id: null, name: '', type: 'balance', category: 'Cash', unit: '', unitPricePence: 0,
    interestRatePct: '', note: ''
  };

  openSheet(existing ? `Edit ${existing.name}` : 'Add an account', `
    <form data-form="account" data-arg="${esc(accountId || '')}" novalidate>
      <div class="field">
        <label for="acc-name">Name</label>
        <input class="input" id="acc-name" name="name" type="text" value="${esc(a.name)}"
               maxlength="60" autocomplete="off" required>
        <p class="field-error" data-error="name" hidden></p>
      </div>

      <div class="field">
        <label for="acc-type">Type</label>
        <select class="select" id="acc-type" name="type" ${existing ? 'disabled' : ''}>
          <option value="balance"${a.type === 'balance' ? ' selected' : ''}>Balance, I record a value</option>
          <option value="quantity"${a.type === 'quantity' ? ' selected' : ''}>Quantity, I record units and a price</option>
          <option value="liability"${a.type === 'liability' ? ' selected' : ''}>Debt, money I owe</option>
        </select>
        ${existing ? '<p class="field-hint">The type cannot change once there is history against it.</p>' : ''}
      </div>

      <div class="field">
        <label for="acc-category">Category</label>
        <select class="select" id="acc-category" name="category">
          ${CATEGORIES.map((c) => `<option value="${esc(c)}"${a.category === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}
        </select>
      </div>

      <div data-when-type="quantity" ${a.type === 'quantity' ? '' : 'hidden'}>
        <div class="field-row">
          <div class="field">
            <label for="acc-unit">Unit name</label>
            <input class="input" id="acc-unit" name="unit" type="text" value="${esc(a.unit || '')}"
                   placeholder="BTC, oz" maxlength="12" autocomplete="off">
          </div>
          <div class="field">
            <label for="acc-price">Price per unit</label>
            <input class="input" id="acc-price" name="unitPrice" type="text" inputmode="decimal"
                   value="${esc(a.unitPricePence ? (a.unitPricePence / 100).toFixed(2) : '')}">
          </div>
        </div>
        <p class="field-error" data-error="unitPrice" hidden></p>
      </div>

      <div class="field" data-when-type="liability" ${a.type === 'liability' ? '' : 'hidden'}>
        <label for="acc-rate">Annual interest rate, optional</label>
        <input class="input" id="acc-rate" name="interestRatePct" type="text" inputmode="decimal"
               value="${esc(a.interestRatePct === '' || a.interestRatePct === undefined ? '' : a.interestRatePct)}"
               placeholder="6.9">
        <p class="field-hint">Used to project when the debt clears at your current payment rate.</p>
        <p class="field-error" data-error="interestRatePct" hidden></p>
      </div>

      <div class="field">
        <label for="acc-note">Note, optional</label>
        <input class="input" id="acc-note" name="note" type="text" value="${esc(a.note || '')}" maxlength="120">
      </div>

      <div class="form-actions">
        <button type="button" class="button" data-action="close-sheet">Cancel</button>
        <button type="submit" class="button is-primary">${existing ? 'Save changes' : 'Add account'}</button>
      </div>
    </form>`);

  const typeSelect = byId('acc-type');
  if (typeSelect) {
    typeSelect.addEventListener('change', () => {
      const value = typeSelect.value;
      document.querySelectorAll('[data-when-type]').forEach((el) => {
        el.hidden = el.dataset.whenType !== value;
      });
      const categorySelect = byId('acc-category');
      if (value === 'liability') categorySelect.value = 'Debt';
      else if (categorySelect.value === 'Debt') categorySelect.value = 'Cash';
    });
  }
}

function transactionForm({ accountId, direction = 'in', txId = null }) {
  const existing = txId ? app.state.transactions.find((t) => t.id === txId) : null;
  const account = accountById(existing ? existing.accountId : accountId);
  if (!account) return;

  const dir = existing ? existing.direction : direction;
  const isDebt = account.type === 'liability';
  const isQuantity = account.type === 'quantity';
  const today = todayISO();
  const entry = balancesAt(app.state, today).get(account.id) || { valuePence: 0, pricePence: 0 };

  const inLabel = isDebt ? 'Add to debt' : 'Add money';
  const outLabel = isDebt ? 'Make a payment' : 'Withdraw money';
  const price = existing && existing.unitPricePence
    ? existing.unitPricePence
    : (account.unitPricePence || entry.pricePence || 0);

  openSheet(existing ? 'Edit entry' : `${dir === 'in' ? inLabel : outLabel} · ${account.name}`, `
    <form data-form="transaction" data-arg="${esc(existing ? existing.id : '')}"
          data-account="${esc(account.id)}" novalidate>
      <div class="field">
        <label id="dir-label">Direction</label>
        <div class="segmented" role="group" aria-labelledby="dir-label">
          <button type="button" data-set-direction="in" aria-pressed="${dir === 'in'}">${esc(inLabel)}</button>
          <button type="button" data-set-direction="out" aria-pressed="${dir === 'out'}">${esc(outLabel)}</button>
        </div>
        <input type="hidden" name="direction" value="${esc(dir)}">
      </div>

      ${isQuantity ? `
        <div class="field">
          <label id="mode-label">Record this entry in</label>
          <div class="segmented" role="group" aria-labelledby="mode-label">
            <button type="button" data-set-mode="money" aria-pressed="true">Pounds</button>
            <button type="button" data-set-mode="units" aria-pressed="false">${esc(account.unit || 'Units')}</button>
          </div>
          <input type="hidden" name="mode" value="money">
        </div>` : ''}

      <div class="field" data-mode-field="money">
        <label for="tx-amount">Amount in pounds</label>
        <input class="input" id="tx-amount" name="amount" type="text" inputmode="decimal"
               value="${esc(existing ? (existing.amountPence / 100).toFixed(2) : '')}"
               placeholder="0.00" autocomplete="off">
        <p class="field-error" data-error="amount" hidden></p>
      </div>

      ${isQuantity ? `
        <div class="field" data-mode-field="units" hidden>
          <label for="tx-units">Quantity in ${esc(account.unit || 'units')}</label>
          <input class="input" id="tx-units" name="units" type="text" inputmode="decimal"
                 value="${esc(existing && existing.unitsE8 ? formatUnits(existing.unitsE8, 8) : '')}"
                 placeholder="0.00000000" autocomplete="off">
          <p class="field-error" data-error="units" hidden></p>
        </div>
        <div class="field">
          <label for="tx-price">Price per ${esc(account.unit || 'unit')} on that date</label>
          <input class="input" id="tx-price" name="unitPrice" type="text" inputmode="decimal"
                 value="${esc(price ? (price / 100).toFixed(2) : '')}" autocomplete="off">
          <p class="field-hint">Used to convert between pounds and ${esc(account.unit || 'units')},
            and to value the holding on that date.</p>
          <p class="field-error" data-error="unitPrice" hidden></p>
        </div>` : ''}

      <div class="field">
        <label for="tx-date">Date</label>
        <input class="input" id="tx-date" name="date" type="date"
               value="${esc(existing ? existing.date : today)}" max="${esc(today)}">
        <p class="field-hint">Backdate this freely. The charts reorder themselves.</p>
        <p class="field-error" data-error="date" hidden></p>
      </div>

      <div class="field">
        <label for="tx-note">Note, optional</label>
        <input class="input" id="tx-note" name="note" type="text"
               value="${esc(existing ? existing.note : '')}" maxlength="120" autocomplete="off">
      </div>

      <p class="field-error" data-error="form" hidden></p>

      <div class="form-actions">
        <button type="button" class="button" data-action="close-sheet">Cancel</button>
        <button type="submit" class="button is-primary">${existing ? 'Save changes' : 'Save entry'}</button>
      </div>
      ${existing ? `<div class="form-actions">
        <button type="button" class="button is-danger" data-action="delete-tx"
                data-arg="${esc(existing.id)}" style="width:100%">Delete this entry</button>
      </div>` : ''}
    </form>`);

  const sheet = byId('sheet');
  sheet.querySelectorAll('[data-set-direction]').forEach((button) => {
    button.addEventListener('click', () => {
      sheet.querySelectorAll('[data-set-direction]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
      button.setAttribute('aria-pressed', 'true');
      sheet.querySelector('input[name="direction"]').value = button.dataset.setDirection;
    });
  });
  sheet.querySelectorAll('[data-set-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      const mode = button.dataset.setMode;
      sheet.querySelectorAll('[data-set-mode]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
      button.setAttribute('aria-pressed', 'true');
      sheet.querySelector('input[name="mode"]').value = mode;
      sheet.querySelectorAll('[data-mode-field]').forEach((field) => {
        field.hidden = field.dataset.modeField !== mode;
      });
    });
  });
}

function goalForm(accountId) {
  const account = accountById(accountId);
  if (!account) return;
  const isDebt = account.type === 'liability';
  const today = todayISO();
  const entry = balancesAt(app.state, today).get(account.id) || { valuePence: 0 };
  const goal = account.goal;

  openSheet(`Goal for ${account.name}`, `
    <form data-form="goal" data-arg="${esc(account.id)}" novalidate>
      ${isDebt
    ? `<p class="section-hint">For a debt the goal is a payoff date. The target is normally zero,
         meaning cleared in full.</p>`
    : ''}
      <div class="field">
        <label for="goal-target">${esc(isDebt ? 'Target balance, normally 0' : 'Target amount')}</label>
        <input class="input" id="goal-target" name="target" type="text" inputmode="decimal"
               value="${esc(goal ? (goal.targetPence / 100).toFixed(2) : (isDebt ? '0.00' : ''))}"
               autocomplete="off">
        <p class="field-error" data-error="target" hidden></p>
      </div>
      <div class="field">
        <label for="goal-date">Target date</label>
        <input class="input" id="goal-date" name="date" type="date"
               value="${esc(goal && goal.targetDate ? goal.targetDate : addDays(today, 365))}">
        <p class="field-error" data-error="date" hidden></p>
      </div>
      <div class="field">
        <label for="goal-start">Starting point</label>
        <input class="input" id="goal-start" name="start" type="text" inputmode="decimal"
               value="${esc(goal ? (goal.startPence / 100).toFixed(2) : (entry.valuePence / 100).toFixed(2))}"
               autocomplete="off">
        <p class="field-hint">Where you were when the goal began. Used for the pace marker.</p>
        <p class="field-error" data-error="start" hidden></p>
      </div>
      <div class="form-actions">
        <button type="button" class="button" data-action="close-sheet">Cancel</button>
        <button type="submit" class="button is-primary">Save goal</button>
      </div>
    </form>`);
}

function galleryForm() {
  const enabledCount = app.state.visuals.filter((v) => v.enabled).length;
  openSheet('Visuals', `
    <p class="section-hint">Switch visuals on and off, and use the arrows on the home screen to
      reorder them. Your layout is saved with your data.</p>
    <div class="row-list">
      ${app.state.visuals.map((visual, index) => {
    const meta = VISUAL_LIBRARY[visual.id] || { name: visual.id, blurb: '' };
    return `
        <div class="gallery-item">
          <div>
            <p class="gallery-name">${esc(meta.name)}</p>
            <p class="gallery-blurb">${esc(meta.blurb)}</p>
          </div>
          <button type="button" class="button is-icon is-quiet" data-action="move-visual"
                  data-arg="${esc(visual.id)}" data-dir="up" ${index === 0 ? 'disabled' : ''}
                  aria-label="Move ${esc(meta.name)} up">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
                 stroke-width="2" aria-hidden="true"><path d="M6 15l6-6 6 6" stroke-linecap="round"
                 stroke-linejoin="round"/></svg>
          </button>
          <button type="button" class="button is-icon is-quiet" data-action="move-visual"
                  data-arg="${esc(visual.id)}" data-dir="down"
                  ${index === app.state.visuals.length - 1 ? 'disabled' : ''}
                  aria-label="Move ${esc(meta.name)} down">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
                 stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6" stroke-linecap="round"
                 stroke-linejoin="round"/></svg>
          </button>
          <button type="button" class="button is-small${visual.enabled ? ' is-primary' : ''}"
                  data-action="toggle-visual" data-arg="${esc(visual.id)}"
                  aria-pressed="${visual.enabled}">${visual.enabled ? 'On' : 'Off'}</button>
        </div>`;
  }).join('')}
    </div>
    <p class="field-hint" style="margin-top:12px">${enabledCount} of
      ${app.state.visuals.length} showing.</p>
    <div class="form-actions">
      <button type="button" class="button is-primary" data-action="close-sheet" style="width:100%">Done</button>
    </div>`);
}

/* ------------------------------------------------------------------ */
/* Form validation and submission                                      */
/* ------------------------------------------------------------------ */

function setFieldError(form, name, message) {
  const holder = form.querySelector(`[data-error="${name}"]`);
  const input = form.querySelector(`[name="${name}"]`);
  if (holder) {
    holder.textContent = message || '';
    holder.hidden = !message;
  }
  if (input) input.classList.toggle('has-error', Boolean(message));
}

function clearErrors(form) {
  form.querySelectorAll('[data-error]').forEach((el) => { el.hidden = true; el.textContent = ''; });
  form.querySelectorAll('.has-error').forEach((el) => el.classList.remove('has-error'));
}

function handleAccountSubmit(form) {
  clearErrors(form);
  const data = new FormData(form);
  const id = form.dataset.arg || null;
  const existing = id ? accountById(id) : null;

  const name = String(data.get('name') || '').trim();
  if (!name) { setFieldError(form, 'name', 'Give the account a name.'); return; }
  const clash = app.state.accounts.some((a) => a.id !== id
    && a.name.toLowerCase() === name.toLowerCase());
  if (clash) { setFieldError(form, 'name', 'Another account already has that name.'); return; }

  const type = existing ? existing.type : String(data.get('type') || 'balance');
  const category = String(data.get('category') || 'Cash');

  let unitPricePence = existing ? (existing.unitPricePence || 0) : 0;
  if (type === 'quantity') {
    const raw = String(data.get('unitPrice') || '').trim();
    if (raw !== '') {
      const parsed = parseMoneyToPence(raw, { allowZero: true });
      if (!parsed.ok) { setFieldError(form, 'unitPrice', parsed.error); return; }
      unitPricePence = parsed.pence;
    }
  }

  let interestRatePct = existing ? existing.interestRatePct : undefined;
  if (type === 'liability') {
    const raw = String(data.get('interestRatePct') || '').trim();
    if (raw === '') interestRatePct = undefined;
    else if (!/^\d{1,3}(\.\d{1,2})?$/.test(raw)) {
      setFieldError(form, 'interestRatePct', 'Enter a rate like 6.9, or leave it blank.');
      return;
    } else interestRatePct = Number(raw);
  }

  commit((draft) => {
    if (existing) {
      const target = draft.accounts.find((a) => a.id === id);
      target.name = name;
      target.category = category;
      target.note = String(data.get('note') || '').trim();
      if (type === 'quantity') {
        target.unit = String(data.get('unit') || '').trim() || 'units';
        if (target.unitPricePence !== unitPricePence) {
          target.unitPricePence = unitPricePence;
          target.priceUpdatedAt = todayISO();
          target.priceSource = 'manual';
        }
      }
      if (type === 'liability') {
        if (interestRatePct === undefined) delete target.interestRatePct;
        else target.interestRatePct = interestRatePct;
      }
    } else {
      const account = {
        id: nextId('acc'),
        name,
        type,
        category: type === 'liability' ? 'Debt' : category,
        order: draft.accounts.length,
        colourIndex: 5,
        archived: false,
        goal: null,
        note: String(data.get('note') || '').trim()
      };
      if (type === 'quantity') {
        account.unit = String(data.get('unit') || '').trim() || 'units';
        account.unitPricePence = unitPricePence;
        account.priceUpdatedAt = unitPricePence ? todayISO() : null;
        account.priceSource = 'manual';
      }
      if (type === 'liability' && interestRatePct !== undefined) {
        account.interestRatePct = interestRatePct;
      }
      draft.accounts.push(account);
      const slots = assignAccountColours(draft.accounts);
      draft.accounts.forEach((a) => {
        if (slots.has(a.id)) a.colourIndex = slots.get(a.id);
      });
    }
  });

  closeSheet();
}

function handleTransactionSubmit(form, { force = false } = {}) {
  clearErrors(form);
  const data = new FormData(form);
  const txId = form.dataset.arg || null;
  const account = accountById(form.dataset.account);
  if (!account) return;

  const direction = data.get('direction') === 'out' ? 'out' : 'in';
  const isQuantity = account.type === 'quantity';
  const mode = isQuantity ? String(data.get('mode') || 'money') : 'money';

  const date = String(data.get('date') || '');
  if (!isValidISODate(date)) {
    setFieldError(form, 'date', 'That is not a real date.');
    return;
  }
  const today = todayISO();
  if (date > today) {
    setFieldError(form, 'date', 'Entries cannot be dated in the future.');
    return;
  }

  let unitPricePence = null;
  if (isQuantity) {
    const parsedPrice = parseMoneyToPence(String(data.get('unitPrice') || ''), { allowZero: true });
    if (!parsedPrice.ok) { setFieldError(form, 'unitPrice', parsedPrice.error); return; }
    unitPricePence = parsedPrice.pence;
    if (mode === 'units' && unitPricePence === 0) {
      setFieldError(form, 'unitPrice', 'A price is needed to work out what those units are worth.');
      return;
    }
  }

  let amountPence = 0;
  let unitsE8 = 0;
  if (mode === 'units') {
    const parsed = parseUnitsToE8(String(data.get('units') || ''));
    if (!parsed.ok) { setFieldError(form, 'units', parsed.error); return; }
    unitsE8 = parsed.unitsE8;
    amountPence = quantityValuePence(unitsE8, unitPricePence);
  } else {
    const parsed = parseMoneyToPence(String(data.get('amount') || ''));
    if (!parsed.ok) { setFieldError(form, 'amount', parsed.error); return; }
    amountPence = parsed.pence;
    if (isQuantity) {
      if (!unitPricePence) {
        setFieldError(form, 'unitPrice', 'A price is needed to work out how many units this buys.');
        return;
      }
      unitsE8 = unitsForPence(amountPence, unitPricePence);
    }
  }

  // Warn before a withdrawal that takes an asset below zero.
  if (direction === 'out' && !force) {
    const balances = balancesAt(app.state, today);
    const entry = balances.get(account.id) || { valuePence: 0, unitsE8: 0 };
    const currentValue = txId
      ? entry.valuePence + originalSignedValue(txId)
      : entry.valuePence;
    const check = checkWithdrawal(account, currentValue, amountPence);
    if (!check.ok) {
      setFieldError(form, 'form', `${check.warning} Press save again to record it anyway.`);
      form.dataset.forceNext = '1';
      return;
    }
  }

  commit((draft) => {
    if (txId) {
      const target = draft.transactions.find((t) => t.id === txId);
      target.direction = direction;
      target.amountPence = amountPence;
      target.unitsE8 = unitsE8;
      target.unitPricePence = unitPricePence;
      target.date = date;
      target.note = String(data.get('note') || '').trim();
    } else {
      draft.transactions.push({
        id: nextId('tx'),
        accountId: account.id,
        date,
        direction,
        amountPence,
        unitsE8,
        unitPricePence,
        note: String(data.get('note') || '').trim(),
        createdAt: new Date().toISOString()
      });
    }
  });

  closeSheet();
}

/** How much an existing entry currently contributes, so an edit compares fairly. */
function originalSignedValue(txId) {
  const tx = app.state.transactions.find((t) => t.id === txId);
  if (!tx) return 0;
  const account = accountById(tx.accountId);
  if (!account) return 0;
  if (account.type === 'quantity') {
    const value = quantityValuePence(tx.unitsE8, account.unitPricePence || 0);
    return tx.direction === 'out' ? -value : value;
  }
  return tx.direction === 'out' ? -tx.amountPence : tx.amountPence;
}

function handleGoalSubmit(form) {
  clearErrors(form);
  const data = new FormData(form);
  const account = accountById(form.dataset.arg);
  if (!account) return;

  const target = parseMoneyToPence(String(data.get('target') || ''), { allowZero: true });
  if (!target.ok) { setFieldError(form, 'target', target.error); return; }

  const date = String(data.get('date') || '');
  if (!isValidISODate(date)) { setFieldError(form, 'date', 'That is not a real date.'); return; }

  const start = parseMoneyToPence(String(data.get('start') || '0'), { allowZero: true, allowNegative: true });
  if (!start.ok) { setFieldError(form, 'start', start.error); return; }

  commit((draft) => {
    const acc = draft.accounts.find((a) => a.id === account.id);
    acc.goal = {
      targetPence: target.pence,
      targetDate: date,
      startDate: (acc.goal && acc.goal.startDate) || todayISO(),
      startPence: start.pence
    };
  });
  closeSheet();
}

/* ------------------------------------------------------------------ */
/* Export and import                                                   */
/* ------------------------------------------------------------------ */

function exportJson() {
  const today = todayISO();
  const text = store.toExportJson(app.state);
  const result = store.downloadText(store.exportFilename(today, 'json'), text, 'application/json');
  if (!result.ok) {
    addBanner({ kind: 'error', title: 'The export did not start', body: result.message });
    return;
  }
  commit((draft) => { draft.lastExportAt = today; });
  app.banners = app.banners.filter((b) => b.key !== 'backup-reminder');
  renderBanners();
  addBanner({
    kind: 'success', key: 'exported', title: 'Backup downloaded',
    body: 'Keep that file somewhere safe. Importing it later restores everything exactly.'
  });
}

function exportCsv() {
  const result = store.downloadText(
    store.exportFilename(todayISO(), 'csv'),
    transactionsToCsv(app.state),
    'text/csv'
  );
  if (!result.ok) addBanner({ kind: 'error', title: 'The export did not start', body: result.message });
}

function exportDamaged() {
  const snapshot = store.rawSnapshot();
  const text = JSON.stringify({
    note: 'Damaged Phthalo Finance data, saved so nothing is lost.',
    savedAt: new Date().toISOString(),
    primary: snapshot.primary,
    backup: snapshot.backup
  }, null, 2);
  store.downloadText(`phthalo-finance-damaged-${todayISO()}.json`, text, 'application/json');
}

function importJson() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onerror = () => {
      addBanner({ kind: 'error', title: 'That file could not be read', body: 'Try exporting it again.' });
    };
    reader.onload = () => {
      const parsed = store.parseImport(String(reader.result || ''), todayISO());
      if (!parsed.ok) {
        addBanner({
          kind: 'error',
          title: 'That file was not imported',
          body: `Nothing has changed. ${parsed.errors.join(' ')}`
        });
        return;
      }
      confirmSheet({
        title: 'Import this backup?',
        body: `The file holds ${parsed.state.accounts.length} accounts and `
          + `${parsed.state.transactions.length} entries. Importing replaces everything currently `
          + 'in the app. Export what you have first if you are not sure.',
        confirmLabel: 'Replace my data',
        extraAction: { label: 'Export what I have first', action: 'export-json' },
        onConfirm: () => {
          app.state = parsed.state;
          const saved = store.save(app.state);
          closeSheet();
          render();
          addBanner({
            kind: saved.ok ? 'success' : 'error',
            title: saved.ok ? 'Backup imported' : 'Imported, but not saved',
            body: saved.ok
              ? `${parsed.state.accounts.length} accounts and ${parsed.state.transactions.length} entries are back.`
              : saved.message
          });
        }
      });
    };
    reader.readAsText(file);
  });
  input.click();
}

/* ------------------------------------------------------------------ */
/* Prices                                                              */
/* ------------------------------------------------------------------ */

let refreshing = false;

async function refreshPrices() {
  if (refreshing) return;
  refreshing = true;
  addBanner({ kind: 'info', key: 'price-refresh', title: 'Checking prices', body: 'This takes a few seconds at most.' });
  try {
    const result = await fetchPrices(app.state.accounts);
    app.banners = app.banners.filter((b) => b.key !== 'price-refresh');
    if (result.prices.size) {
      commit((draft) => {
        const today = todayISO();
        for (const account of draft.accounts) {
          if (result.prices.has(account.id)) {
            account.unitPricePence = result.prices.get(account.id);
            account.priceUpdatedAt = today;
            account.priceSource = 'live';
          }
        }
      });
    } else {
      renderBanners();
    }
    addBanner({
      kind: result.failures.length && !result.prices.size ? 'info' : 'success',
      title: result.prices.size ? 'Prices updated' : 'Prices left as they were',
      body: describeResult(result)
    });
  } catch (error) {
    app.banners = app.banners.filter((b) => b.key !== 'price-refresh');
    addBanner({
      kind: 'info',
      title: 'Prices left as they were',
      body: `The price refresh could not run (${error.message}). Your manual prices are untouched.`
    });
  } finally {
    refreshing = false;
  }
}

/* ------------------------------------------------------------------ */
/* Theme                                                               */
/* ------------------------------------------------------------------ */

function resolveTheme(setting) {
  if (setting === 'light' || setting === 'dark') return setting;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
    ? 'light' : 'dark';
}

function applyTheme(setting) {
  document.documentElement.setAttribute('data-theme', resolveTheme(setting));
}

function watchSystemTheme() {
  if (!window.matchMedia) return;
  const query = window.matchMedia('(prefers-color-scheme: light)');
  const handler = () => {
    if ((app.state.settings.theme || 'system') === 'system') {
      applyTheme('system');
      if (app.view === 'home') renderHome();
    }
  };
  if (query.addEventListener) query.addEventListener('change', handler);
  else if (query.addListener) query.addListener(handler);
}

/* ------------------------------------------------------------------ */
/* Tooltips                                                            */
/* ------------------------------------------------------------------ */

function showTooltip(target) {
  const text = target.getAttribute('data-tip');
  if (!text) return;
  const tooltip = byId('tooltip');
  tooltip.textContent = text;
  tooltip.hidden = false;
  const box = target.getBoundingClientRect();
  const size = tooltip.getBoundingClientRect();
  let left = box.left + (box.width / 2) - (size.width / 2);
  left = Math.max(8, Math.min(left, window.innerWidth - size.width - 8));
  let top = box.top - size.height - 8;
  if (top < 8) top = box.bottom + 8;
  tooltip.style.left = `${Math.round(left)}px`;
  tooltip.style.top = `${Math.round(top)}px`;
}

function hideTooltip() {
  const tooltip = byId('tooltip');
  if (tooltip) tooltip.hidden = true;
}

/* ------------------------------------------------------------------ */
/* Service worker                                                      */
/* ------------------------------------------------------------------ */

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (window.location.protocol === 'file:') return;
  navigator.serviceWorker.register('./sw.js').then((registration) => {
    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          addBanner({
            kind: 'info',
            key: 'sw-update',
            title: 'A new version is ready',
            body: 'Reload to pick it up. Your data is not affected.',
            actions: [{ label: 'Reload now', action: 'apply-update', primary: true }]
          });
        }
      });
    });
  }).catch(() => {
    // Offline support is a bonus, never a reason to break the app.
  });

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}

function applyUpdate() {
  if (!('serviceWorker' in navigator)) { window.location.reload(); return; }
  navigator.serviceWorker.getRegistration().then((registration) => {
    if (registration && registration.waiting) {
      registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    } else {
      window.location.reload();
    }
  }).catch(() => window.location.reload());
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

const ACTIONS = {
  go(el) { app.view = el.dataset.view; render(); window.scrollTo(0, 0); },

  'close-sheet': closeSheet,

  'dismiss-banner'(el) { removeBanner(el.dataset.arg); },

  'dismiss-ios-notice'() {
    commit((draft) => { draft.settings.notices.iosStorage = true; });
    app.banners = app.banners.filter((b) => b.key !== 'ios-storage');
    renderBanners();
  },

  'toggle-theme'() {
    const current = resolveTheme(app.state.settings.theme || 'system');
    const next = current === 'dark' ? 'light' : 'dark';
    commit((draft) => { draft.settings.theme = next; });
    applyTheme(next);
  },

  'set-range'(el) {
    commit((draft) => { draft.settings.netWorthRange = el.dataset.range; });
  },

  'open-gallery': galleryForm,

  'toggle-visual'(el) {
    commit((draft) => {
      const visual = draft.visuals.find((v) => v.id === el.dataset.arg);
      if (visual) visual.enabled = !visual.enabled;
    });
    galleryForm();
  },

  'hide-visual'(el) {
    commit((draft) => {
      const visual = draft.visuals.find((v) => v.id === el.dataset.arg);
      if (visual) visual.enabled = false;
    });
  },

  'move-visual'(el) {
    const dir = el.dataset.dir === 'up' ? -1 : 1;
    commit((draft) => {
      const list = draft.visuals.filter((v) => v.enabled);
      const source = draft.visuals;
      const index = source.findIndex((v) => v.id === el.dataset.arg);
      if (index < 0) return;
      // Move past the neighbour that is actually visible on the home screen.
      let swapWith = index + dir;
      if (list.length && source[index].enabled) {
        swapWith = index + dir;
        while (swapWith >= 0 && swapWith < source.length && !source[swapWith].enabled) swapWith += dir;
      }
      if (swapWith < 0 || swapWith >= source.length) return;
      const [moved] = source.splice(index, 1);
      source.splice(swapWith, 0, moved);
      source.forEach((v, i) => { v.order = i; });
    });
    if (!byId('sheet-backdrop').hidden) galleryForm();
  },

  'add-account'() { accountForm(null); },
  'edit-account'(el) { accountForm(el.dataset.arg); },
  'open-account'(el) { openAccount(el.dataset.arg); },
  'edit-goal'(el) { goalForm(el.dataset.arg); },

  'clear-goal'(el) {
    const id = el.dataset.arg;
    commit((draft) => {
      const account = draft.accounts.find((a) => a.id === id);
      if (account) account.goal = null;
    });
    openAccount(id);
  },

  'move-account'(el) {
    const dir = el.dataset.dir === 'up' ? -1 : 1;
    const insideSheet = Boolean(el.closest('#sheet'));
    commit((draft) => {
      const list = draft.accounts.filter((a) => !a.archived)
        .sort((a, b) => a.order - b.order);
      const index = list.findIndex((a) => a.id === el.dataset.arg);
      if (index < 0 || index + dir < 0 || index + dir >= list.length) return;
      const swap = list[index + dir];
      const current = list[index];
      const temp = current.order;
      current.order = swap.order;
      swap.order = temp;
    });
    if (insideSheet) openAccount(el.dataset.arg);
  },

  'toggle-archive'(el) {
    const id = el.dataset.arg;
    commit((draft) => {
      const account = draft.accounts.find((a) => a.id === id);
      if (account) account.archived = !account.archived;
    });
    closeSheet();
  },

  'delete-account'(el) {
    const account = accountById(el.dataset.arg);
    if (!account) return;
    const count = app.state.transactions.filter((t) => t.accountId === account.id).length;
    confirmSheet({
      title: `Delete ${account.name}?`,
      body: `This removes the account and all ${count} of its entries. `
        + 'That history is gone from every chart and cannot be undone. '
        + 'Export a backup first if there is any doubt.',
      confirmLabel: 'Delete it',
      danger: true,
      extraAction: { label: 'Export a backup first', action: 'export-json' },
      onConfirm: () => {
        commit((draft) => {
          draft.accounts = draft.accounts.filter((a) => a.id !== account.id);
          draft.transactions = draft.transactions.filter((t) => t.accountId !== account.id);
          draft.accounts.forEach((a, i) => { a.order = i; });
        });
        closeSheet();
        addBanner({
          kind: 'info', title: 'Account deleted',
          body: `${account.name} and its ${count} entries have been removed.`
        });
      }
    });
  },

  'new-tx'(el) {
    transactionForm({ accountId: el.dataset.arg, direction: el.dataset.dir || 'in' });
  },

  'edit-tx'(el) { transactionForm({ txId: el.dataset.arg }); },

  'delete-tx'(el) {
    const tx = app.state.transactions.find((t) => t.id === el.dataset.arg);
    if (!tx) return;
    const account = accountById(tx.accountId);
    confirmSheet({
      title: 'Delete this entry?',
      body: `${formatMoney(tx.amountPence)} ${tx.direction === 'out' ? 'out of' : 'into'} `
        + `${account ? account.name : 'a deleted account'} on ${longDate(tx.date)}. `
        + 'Every chart will be redrawn without it.',
      confirmLabel: 'Delete it',
      danger: true,
      onConfirm: () => {
        commit((draft) => {
          draft.transactions = draft.transactions.filter((t) => t.id !== tx.id);
        });
        closeSheet();
      }
    });
  },

  'save-price'(el) {
    const account = accountById(el.dataset.arg);
    const input = byId('unit-price');
    if (!account || !input) return;
    const parsed = parseMoneyToPence(input.value, { allowZero: true });
    const hint = byId('price-hint');
    if (!parsed.ok) {
      if (hint) { hint.textContent = parsed.error; hint.className = 'field-error'; }
      input.classList.add('has-error');
      return;
    }
    commit((draft) => {
      const target = draft.accounts.find((a) => a.id === account.id);
      target.unitPricePence = parsed.pence;
      target.priceUpdatedAt = todayISO();
      target.priceSource = 'manual';
    });
    openAccount(account.id);
  },

  'export-json': exportJson,
  'export-csv': exportCsv,
  'export-damaged': exportDamaged,
  'import-json': importJson,

  'load-demo'() {
    confirmSheet({
      title: 'Load the demo data?',
      body: 'This replaces everything currently in the app with twelve months of made up '
        + 'activity so you can see every chart working.',
      confirmLabel: 'Load it',
      extraAction: app.state.transactions.length
        ? { label: 'Export what I have first', action: 'export-json' } : null,
      onConfirm: () => {
        const next = demoState(todayISO());
        app.state = next;
        store.save(app.state);
        closeSheet();
        app.view = 'home';
        render();
        addBanner({
          kind: 'success', title: 'Demo data loaded',
          body: `${next.transactions.length} entries across ${next.accounts.length} accounts. `
            + 'Use "Clear all data" on the Data tab when you have finished looking.'
        });
      }
    });
  },

  'clear-all'() {
    confirmSheet({
      title: 'Clear everything?',
      body: 'Every account, entry and goal is removed from this browser and cannot be recovered '
        + 'without a backup file. The ten starting accounts come back empty.',
      confirmLabel: 'Clear it all',
      danger: true,
      extraAction: app.state.transactions.length
        ? { label: 'Export a backup first', action: 'export-json' } : null,
      onConfirm: () => {
        store.clearAll();
        app.state = emptyStateWithDefaults(todayISO());
        store.save(app.state);
        app.banners = [];
        closeSheet();
        app.view = 'home';
        render();
        addBanner({ kind: 'info', title: 'All data cleared', body: 'You are back to an empty start.' });
      }
    });
  },

  'refresh-prices': refreshPrices,
  'apply-update': applyUpdate,

  'recovery-export'() {
    try {
      const snapshot = store.rawSnapshot();
      store.downloadText(`phthalo-finance-recovery-${todayISO()}.json`,
        snapshot.primary || store.toExportJson(app.state || {}), 'application/json');
    } catch {
      window.alert('The export could not run. Copy the technical detail below and reload.');
    }
  },

  'recovery-reload'() { window.location.reload(); }
};

ACTIONS['run-confirm'] = function runConfirm() {
  const handler = app.pendingConfirm;
  app.pendingConfirm = null;
  if (typeof handler === 'function') handler();
};

/* ------------------------------------------------------------------ */
/* Event wiring                                                        */
/* ------------------------------------------------------------------ */

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) {
    if (event.target.id === 'sheet-backdrop') closeSheet();
    return;
  }
  const name = target.dataset.action;
  const handler = ACTIONS[name];
  if (typeof handler !== 'function') return;
  event.preventDefault();
  try {
    handler(target);
  } catch (error) {
    addBanner({
      kind: 'error',
      title: 'That did not work',
      body: `${error.message}. Nothing has been changed.`
    });
  }
});

document.addEventListener('change', (event) => {
  if (event.target.dataset && event.target.dataset.action === 'set-theme') {
    const value = event.target.value;
    commit((draft) => { draft.settings.theme = value; }, { silent: true });
    applyTheme(value);
  }
});

document.addEventListener('submit', (event) => {
  const form = event.target.closest('form[data-form]');
  if (!form) return;
  event.preventDefault();
  try {
    const kind = form.dataset.form;
    if (kind === 'account') handleAccountSubmit(form);
    else if (kind === 'transaction') {
      const force = form.dataset.forceNext === '1';
      form.dataset.forceNext = '';
      handleTransactionSubmit(form, { force });
    } else if (kind === 'goal') handleGoalSubmit(form);
  } catch (error) {
    addBanner({
      kind: 'error',
      title: 'That could not be saved',
      body: `${error.message}. Nothing has been changed.`
    });
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (!byId('sheet-backdrop').hidden) closeSheet();
    hideTooltip();
  }
});

// Tooltips on hover, on focus and on tap.
document.addEventListener('pointerover', (event) => {
  const target = event.target.closest('[data-tip]');
  if (target) showTooltip(target);
});
document.addEventListener('pointerout', (event) => {
  if (event.target.closest('[data-tip]')) hideTooltip();
});
document.addEventListener('focusin', (event) => {
  const target = event.target.closest('[data-tip]');
  if (target) showTooltip(target);
});
document.addEventListener('focusout', hideTooltip);
document.addEventListener('scroll', hideTooltip, { passive: true });

let resizeTimer = null;
window.addEventListener('resize', () => {
  if (resizeTimer) window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    if (app.view === 'home' && Math.abs(window.innerWidth - app.lastWidth) > 8) renderHome();
  }, 160);
});

/* ------------------------------------------------------------------ */

try {
  boot();
} catch (error) {
  showRecovery('The app could not start.', error && error.stack ? error.stack : String(error));
}

// Handy for the browser test page and for poking about in the console.
window.phthalo = { app, store, todayISO };
