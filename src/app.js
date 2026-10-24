/**
 * app.js
 *
 * All of the DOM work. Every number on screen comes from a pure function
 * in logic.js; nothing is calculated here.
 *
 * Screens: Home (net worth and the accounts), Insights (the charts),
 * Activity (every entry), Settings, and the account screen, which opens
 * over the others with its own back button, as a native app would.
 */

import {
  CATEGORIES,
  VISUAL_LIBRARY,
  accountSeries,
  activeAccounts,
  addDays,
  averageMonthlyRepayment,
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
  quantityValuePence,
  sortedTransactions,
  transactionsToCsv,
  unitsForPence
} from './logic.js';

import {
  badge,
  esc,
  heroBlock,
  lineChart,
  longDate,
  renderVisual,
  shortDate,
  statusChip
} from './charts.js';
import { icon } from './icons.js';
import { demoState, emptyStateWithDefaults } from './seed.js';
import * as store from './storage.js';
import { fetchPrices, describeResult } from './prices.js';

// Tells the repair check in index.html that this release's code is running.
document.documentElement.setAttribute('data-app', 'ready');

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
  showRecovery('A background task failed unexpectedly.', reason && reason.stack ? reason.stack : String(reason));
});

/* ------------------------------------------------------------------ */
/* Application state                                                   */
/* ------------------------------------------------------------------ */

const TAB_VIEWS = ['home', 'insights', 'activity', 'settings'];

const app = {
  state: null,
  view: 'home',
  previousView: 'home',
  accountId: null,
  accountTab: 'overview',
  showArchived: false,
  banners: [],
  bannerSeq: 0,
  saveBlocked: false,
  lastWidth: 0,
  pendingConfirm: null,
  sheetOpen: false
};

const todayISO = () => dateToISO(new Date());
const byId = (id) => document.getElementById(id);

function nextId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function accountById(id) {
  return app.state.accounts.find((a) => a.id === id) || null;
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

function dropBanners(key) {
  app.banners = app.banners.filter((b) => b.key !== key);
}

function renderBanners() {
  const host = byId('banners');
  if (!host) return;
  const glyph = { error: icon.alert, success: icon.check, info: icon.info };
  host.innerHTML = app.banners.map((banner) => `
    <div class="banner is-${esc(banner.kind)}" data-banner="${esc(banner.id)}">
      <span class="banner-icon">${glyph[banner.kind] || icon.info}</span>
      <p class="banner-title">${esc(banner.title)}</p>
      <p class="banner-body">${esc(banner.body)}</p>
      ${banner.actions.length || banner.dismissible ? `<div class="banner-actions">
        ${banner.actions.map((action) => `
          <button type="button" class="button is-small${action.primary ? ' is-primary' : ''}"
                  data-action="${esc(action.action)}"
                  ${action.arg ? `data-arg="${esc(action.arg)}"` : ''}>${esc(action.label)}</button>`).join('')}
        ${banner.dismissible ? `<button type="button" class="button is-small is-quiet"
            data-action="dismiss-banner" data-arg="${esc(banner.id)}">Dismiss</button>` : ''}
      </div>` : ''}
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
      body: 'Nothing is sent anywhere and there is no account to create. Load the demo data in '
        + 'Settings to see every chart working, or tap the plus button to add your own money.'
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

  if (!app.state.settings.notices.iosStorage && isIosSafariNotInstalled()) {
    addBanner({
      kind: 'info',
      key: 'ios-storage',
      title: 'Add this to your home screen to keep your data',
      body: 'iOS Safari can clear the storage of a website you have not opened for a few weeks. '
        + 'Adding Phthalo to your home screen stops that happening. Tap Share, then '
        + '"Add to Home Screen".',
      actions: [{ label: 'Got it', action: 'dismiss-ios-notice', primary: true }],
      dismissible: false
    });
  }

  // A reload always starts on Home, never on a stale account address.
  if (window.location.hash) {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  checkBackupReminder();
  applyTheme(app.state.settings.theme || 'system');
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
  if (!app.state.transactions.length) return;
  if (days === null || days >= 30) {
    addBanner({
      kind: 'info',
      key: 'backup-reminder',
      title: days === null ? 'You have never exported a backup' : `Your last backup was ${days} days ago`,
      body: 'A backup is a single file you can keep anywhere. It takes a second, and it is the only '
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
    const onAccount = app.view === 'account' && accountById(app.accountId);
    if (app.view === 'account' && !onAccount) app.view = TAB_VIEWS.includes(app.previousView) ? app.previousView : 'home';

    for (const view of [...TAB_VIEWS, 'account']) {
      const el = byId(`view-${view}`);
      if (el) el.hidden = view !== app.view;
    }
    document.body.classList.toggle('is-detail', app.view === 'account');
    document.querySelectorAll('.tabbar button[data-view]').forEach((button) => {
      if (button.dataset.view === app.view) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    // The add button lives where adding makes sense, and never on an archived account.
    const fab = byId('fab');
    // On an account's overview the Add money and Withdraw buttons already
    // sit in view, so the floating button would only cover them.
    const viewing = app.view === 'account' ? accountById(app.accountId) : null;
    fab.hidden = !['home', 'activity', 'account'].includes(app.view)
      || (viewing && (viewing.archived || app.accountTab === 'overview'));

    if (app.view === 'home') renderHome();
    else if (app.view === 'insights') renderInsights();
    else if (app.view === 'activity') renderActivity();
    else if (app.view === 'settings') renderSettings();
    else if (app.view === 'account') renderAccount();
    app.lastWidth = window.innerWidth;
  } catch (error) {
    showRecovery('The screen could not be drawn.', error && error.stack ? error.stack : String(error));
  }
}

function contentWidth(el) {
  return Math.max(240, Math.floor(el.clientWidth || (window.innerWidth - 32)));
}

/* ---------------- Home ---------------- */

function accountCard(account, entry, today) {
  const isDebt = account.type === 'liability';
  const value = isDebt ? -entry.valuePence : entry.valuePence;
  let meta;
  if (account.type === 'quantity') {
    // Units only. The price is one tap away on the account screen.
    meta = `${formatUnits(entry.unitsE8, 6)} ${account.unit || 'units'}`;
  } else if (isDebt) {
    meta = account.interestRatePct ? `${account.interestRatePct}% interest` : 'Debt';
  } else {
    meta = account.note || account.category;
  }

  let progress = '';
  const p = account.goal ? goalProgress(account, entry.valuePence, today) : null;
  if (p) {
    const pct = Math.round(p.percent);
    const left = p.isDebt ? `${pct}% paid off` : `${pct}%`;
    const right = p.reached ? 'Target reached'
      : `${formatMoney(p.remainingPence, { showPence: false })} to go`;
    progress = `
      <span class="account-progress">
        <span class="progress" role="img" aria-label="${pct} percent of the goal"><span style="width:${Math.max(p.percent, p.percent > 0 ? 2 : 0).toFixed(1)}%"></span></span>
        <span class="progress-row"><span>${esc(left)}</span><span>${esc(right)}</span></span>
      </span>`;
  }

  return `
    <li>
      <button type="button" class="account-card${account.archived ? ' is-archived' : ''}"
              data-action="open-account" data-arg="${esc(account.id)}">
        ${account.archived ? `<span class="badge badge-archived" aria-hidden="true">${icon.archive}</span>` : badge(isDebt ? 'Debt' : account.category)}
        <span class="account-main">
          <span class="account-name">${esc(account.name)}</span>
          <span class="account-meta">${esc(account.archived ? 'Archived' : meta)}</span>
        </span>
        <span class="account-value${value < 0 ? ' is-negative' : ''}">${esc(account.archived ? '' : formatMoney(value))}</span>
        ${account.archived ? '' : progress}
      </button>
    </li>`;
}

function renderHome() {
  const host = byId('view-home');
  const today = todayISO();
  const balances = balancesAt(app.state, today);
  const accounts = activeAccounts(app.state);
  const assets = accounts.filter((a) => a.type !== 'liability');
  const debts = accounts.filter((a) => a.type === 'liability');
  const archived = app.state.accounts.filter((a) => a.archived);
  const totals = netWorthAt(app.state, today);
  const entryFor = (a) => balances.get(a.id) || { valuePence: 0, unitsE8: 0, pricePence: 0 };

  host.innerHTML = `
    <div class="home-layout">
      <div id="hero-slot"></div>
      <div>
        <div class="section-head">
          <h2 class="section-title">Assets</h2>
          <span class="section-total">${esc(formatMoney(totals.assetsPence))}</span>
        </div>
        ${assets.length
    ? `<ul class="account-list">${assets.map((a) => accountCard(a, entryFor(a), today)).join('')}</ul>`
    : `<div class="empty"><p class="empty-title">No accounts yet</p>
         <p class="empty-body">Add an account for each thing you want to track.</p></div>`}
        ${debts.length ? `
          <div class="section-head">
            <h2 class="section-title">Owed</h2>
            <span class="section-total is-negative">${esc(formatMoney(-totals.liabilitiesPence))}</span>
          </div>
          <ul class="account-list">${debts.map((a) => accountCard(a, entryFor(a), today)).join('')}</ul>` : ''}
        <div class="section-head">
          <button type="button" class="text-button" data-action="add-account">${icon.plus}Add an account</button>
          ${archived.length ? `<button type="button" class="text-button" data-action="toggle-archived-list">
            ${app.showArchived ? 'Hide' : 'Show'} archived (${archived.length})</button>` : ''}
        </div>
        ${archived.length && app.showArchived
    ? `<ul class="account-list">${archived.map((a) => accountCard(a, entryFor(a), today)).join('')}</ul>` : ''}
      </div>
    </div>`;

  const slot = byId('hero-slot');
  slot.innerHTML = heroBlock({ state: app.state, today, width: contentWidth(slot) });
  attachScrub(slot.querySelector('[data-scrub]'), slot.querySelector('[data-readout]'));
}

/* ---------------- Insights ---------------- */

function renderInsights() {
  const host = byId('view-insights');
  const enabled = app.state.visuals.filter((v) => v.enabled && VISUAL_LIBRARY[v.id]);

  if (!enabled.length) {
    host.innerHTML = `
      <div class="empty" style="margin-top:8px">
        <p class="empty-title">Every chart is switched off</p>
        <p class="empty-body">Open the list of charts to put some back.</p>
        <button type="button" class="button is-primary" data-action="open-gallery">Choose charts</button>
      </div>`;
    return;
  }

  host.innerHTML = `
    <div class="visual-list">
      ${enabled.map((visual, index) => {
    const meta = VISUAL_LIBRARY[visual.id];
    return `
        <article class="card" data-visual-id="${esc(visual.id)}">
          <div class="card-head">
            <div>
              <h2 class="card-title">${esc(meta.name)}</h2>
              <p class="card-subtitle">${esc(meta.name)}</p>
            </div>
            <div class="card-tools">
              <button type="button" class="icon-button" data-action="move-visual" data-arg="${esc(visual.id)}"
                      data-dir="up" ${index === 0 ? 'disabled' : ''} aria-label="Move ${esc(meta.name)} up">${icon.up}</button>
              <button type="button" class="icon-button" data-action="move-visual" data-arg="${esc(visual.id)}"
                      data-dir="down" ${index === enabled.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(meta.name)} down">${icon.down}</button>
              <button type="button" class="icon-button" data-action="hide-visual" data-arg="${esc(visual.id)}"
                      aria-label="Remove ${esc(meta.name)}">${icon.close}</button>
            </div>
          </div>
          <div class="card-body"></div>
        </article>`;
  }).join('')}
    </div>
    <div class="section-head">
      <button type="button" class="button is-block" data-action="open-gallery">${icon.sliders}Add or remove charts</button>
    </div>`;

  // Second pass: measure each card and draw at real pixel size.
  const today = todayISO();
  host.querySelectorAll('[data-visual-id]').forEach((card) => {
    const id = card.dataset.visualId;
    const body = card.querySelector('.card-body');
    const result = renderVisual(id, { state: app.state, today, width: contentWidth(body) });
    card.querySelector('.card-title').textContent = result.title;
    body.innerHTML = result.body;
  });
}

/* ---------------- Activity ---------------- */

function recordRow(tx, account, { showAccount = true } = {}) {
  const out = tx.direction === 'out';
  const isDebt = account && account.type === 'liability';
  // For a debt, money in means borrowing more, which is shown as money out.
  const label = !account ? 'Deleted account' : showAccount ? account.name : longDate(tx.date);
  const subParts = [];
  if (showAccount && tx.note) subParts.push(tx.note);
  if (!showAccount) subParts.push(tx.note || (out ? (isDebt ? 'Payment' : 'Money out') : (isDebt ? 'Added to debt' : 'Money in')));
  if (tx.unitsE8) subParts.push(`${formatUnits(tx.unitsE8, 6)} ${account && account.unit ? account.unit : 'units'}`);
  const sub = subParts.join(' · ') || (out ? 'Money out' : 'Money in');
  const lead = showAccount
    ? (account ? badge(isDebt ? 'Debt' : account.category, 'small') : `<span class="badge is-small badge-archived">${icon.archive}</span>`)
    : '';
  return `
    <button type="button" class="list-row${showAccount ? '' : ' no-lead'}" data-action="edit-tx" data-arg="${esc(tx.id)}">
      ${lead}
      <span class="row-main">
        <span class="row-title">${esc(label)}</span>
        <span class="row-sub">${esc(sub)}</span>
      </span>
      <span class="row-end"><span class="row-amount ${out ? 'is-out' : 'is-in'}">${esc(formatMoney(out ? -tx.amountPence : tx.amountPence, { showSign: true }))}</span></span>
    </button>`;
}

function renderActivity() {
  const host = byId('view-activity');
  const accounts = new Map(app.state.accounts.map((a) => [a.id, a]));
  const txs = sortedTransactions(app.state).slice().reverse();

  if (!txs.length) {
    host.innerHTML = `
      <div class="empty" style="margin-top:8px">
        <p class="empty-title">Nothing recorded yet</p>
        <p class="empty-body">Every entry you add, on any account, appears here newest first.</p>
        <button type="button" class="button is-primary" data-action="fab">${icon.plus}Add an entry</button>
      </div>`;
    return;
  }

  const shown = txs.slice(0, 400);
  const groups = new Map();
  for (const tx of shown) {
    if (!groups.has(tx.date)) groups.set(tx.date, []);
    groups.get(tx.date).push(tx);
  }

  host.innerHTML = `
    ${txs.length > 400 ? '<p class="page-intro">Showing the most recent 400 entries.</p>' : ''}
    ${Array.from(groups.entries()).map(([date, list]) => `
      <h2 class="date-head">${esc(longDate(date))}</h2>
      <div class="list-group">${list.map((tx) => recordRow(tx, accounts.get(tx.accountId))).join('')}</div>`).join('')}`;
}

/* ---------------- Settings ---------------- */

function settingsRow({ action, arg, glyph, title, sub, danger = false }) {
  return `
    <button type="button" class="list-row${danger ? ' row-danger' : ''}" data-action="${esc(action)}"${arg ? ` data-arg="${esc(arg)}"` : ''}>
      <span class="row-icon">${glyph}</span>
      <span class="row-main">
        <span class="row-title">${esc(title)}</span>
        ${sub ? `<span class="row-sub">${esc(sub)}</span>` : ''}
      </span>
      <span class="row-chevron">${icon.chevron}</span>
    </button>`;
}

function renderSettings() {
  const host = byId('view-settings');
  const days = store.daysSinceExport(app.state, todayISO());
  const theme = app.state.settings.theme || 'system';
  const archived = app.state.accounts.filter((a) => a.archived);
  const exported = days === null ? 'Never exported'
    : days === 0 ? 'Last exported today' : `Last exported ${days} day${days === 1 ? '' : 's'} ago`;

  host.innerHTML = `
    <div class="section-head" style="margin-top:6px"><h2 class="section-title">Backup</h2></div>
    <div class="list-group">
      ${settingsRow({ action: 'export-json', glyph: icon.download, title: 'Export to JSON', sub: `A complete backup. ${exported}.` })}
      ${settingsRow({ action: 'export-csv', glyph: icon.table, title: 'Export to CSV', sub: 'Every entry, for Excel or Numbers' })}
      ${settingsRow({ action: 'import-json', glyph: icon.upload, title: 'Import from JSON', sub: 'Replaces what is here with a backup' })}
    </div>

    <div class="section-head"><h2 class="section-title">Appearance</h2></div>
    <div class="card">
      <p class="field-label" id="theme-label" style="margin-bottom:8px">Theme</p>
      <div class="segmented" role="group" aria-labelledby="theme-label">
        ${['system', 'dark', 'light'].map((value) => `
          <button type="button" data-action="set-theme" data-value="${value}" aria-pressed="${theme === value}">
            ${{ system: 'Automatic', dark: 'Dark', light: 'Light' }[value]}</button>`).join('')}
      </div>
      <p class="field-hint" style="margin-top:8px">Automatic follows your phone, and uses dark when it has no preference.</p>
    </div>

    <div class="section-head"><h2 class="section-title">Accounts and prices</h2></div>
    <div class="list-group">
      ${settingsRow({ action: 'add-account', glyph: icon.plus, title: 'Add an account' })}
      ${settingsRow({ action: 'refresh-prices', glyph: icon.refresh, title: 'Refresh prices now', sub: 'Keeps your typed price if it fails' })}
      ${archived.map((a) => settingsRow({ action: 'open-account', arg: a.id, glyph: icon.archive, title: a.name, sub: 'Archived' })).join('')}
    </div>

    <div class="section-head"><h2 class="section-title">Sample data</h2></div>
    <div class="list-group">
      ${settingsRow({ action: 'load-demo', glyph: icon.sparkle, title: 'Load demo data', sub: 'Twelve months of made up activity' })}
      ${settingsRow({ action: 'clear-all', glyph: icon.trash, title: 'Clear all data', danger: true })}
    </div>

    <div class="section-head"><h2 class="section-title">About</h2></div>
    <div class="card">
      <p class="muted" style="font-size:14.5px">Phthalo stores everything in this browser and nowhere else.
        Nothing is uploaded and there is no account. If the browser data is cleared, an exported backup
        is the only way back, so export one now and then.
        ${app.state.accounts.length} accounts and ${app.state.transactions.length} entries are stored here.</p>
    </div>`;
}

/* ---------------- Account screen ---------------- */

function ring(fraction) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(1, fraction));
  return `<svg viewBox="0 0 120 120" aria-hidden="true">
    <circle class="ring-track" cx="60" cy="60" r="${r}" stroke-width="10"/>
    ${f > 0 ? `<circle class="ring-fill" cx="60" cy="60" r="${r}" stroke-width="10"
      stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - f)).toFixed(2)}"/>` : ''}
  </svg>`;
}

function goalOverview(account, entry, today) {
  const p = goalProgress(account, entry.valuePence, today);
  const isDebt = p.isDebt;
  const pct = p.exceeded ? Math.round(p.rawPercent) : Math.round(p.percent);

  let countdown;
  if (p.reached) countdown = `<span class="target-countdown is-positive">${p.exceeded ? 'Target passed' : 'Target reached'}</span>`;
  else if (p.overdue) countdown = `<span class="target-countdown is-negative">Passed ${esc(describeTimeRemaining(p.timeRemaining))}</span>`;
  else if (p.timeRemaining) countdown = `<span class="target-countdown">${esc(describeTimeRemaining(p.timeRemaining))} to go</span>`;
  else countdown = '';

  let rates = '';
  if (!p.reached && p.rates.achievable) {
    rates = `<div class="stat-trio">
      <div><p class="stat-label">Daily</p><p class="stat-mid">${esc(formatMoney(p.rates.perDayPence))}</p></div>
      <div><p class="stat-label">Weekly</p><p class="stat-mid">${esc(formatMoney(p.rates.perWeekPence))}</p></div>
      <div><p class="stat-label">Monthly</p><p class="stat-mid">${esc(formatMoney(p.rates.perMonthPence))}</p></div>
    </div>`;
  } else if (!p.reached && !p.rates.achievable) {
    rates = '<p class="muted" style="margin-top:16px;font-size:14.5px">The target date has passed, so no saving rate arrives on time. Edit the goal to set a new date.</p>';
  }

  let pace = '';
  if (p.pace && !p.reached && !p.overdue) {
    const diff = formatMoney(Math.abs(p.pace.differencePence));
    const words = p.pace.status === 'ahead' ? `${diff} ahead of a straight line to the target`
      : p.pace.status === 'behind' ? `${diff} behind a straight line to the target`
        : 'Level with a straight line to the target';
    pace = `<div style="margin-top:18px;display:grid;justify-items:center;gap:6px">
      ${statusChip(p.pace.status)}<p class="muted" style="font-size:13.5px">${esc(words)}</p></div>`;
  }

  const bigLabel = isDebt ? 'Owed' : 'Saved';
  const pair = isDebt
    ? [['Paid off', formatMoney(Math.max(0, p.startPence - p.currentPence))], ['Started at', formatMoney(p.startPence)]]
    : [['Remaining', formatMoney(p.remainingPence)], ['Goal', formatMoney(p.targetPence)]];

  return `
    <div class="goal-hero">
      <div class="ring" role="img" aria-label="${pct} percent of the goal reached">
        ${ring(p.fraction)}
        <div class="ring-centre">
          <span class="ring-percent">${pct}%</span>
          <span class="ring-caption">${isDebt ? 'paid off' : 'of goal'}</span>
        </div>
      </div>
      <p class="stat-label" style="margin-top:18px">${bigLabel}</p>
      <p class="stat-big">${esc(formatMoney(p.currentPence))}</p>
      <div class="stat-pair">
        ${pair.map(([k, v]) => `<div><p class="stat-label">${k}</p><p class="stat-mid">${esc(v)}</p></div>`).join('')}
      </div>
      ${p.targetDate ? `<div class="target">
        <span class="target-pill">${p.overdue ? 'Target was' : 'Target on'} ${esc(shortDate(p.targetDate))}</span>
        ${countdown}
      </div>` : ''}
      ${rates}
      ${pace}
    </div>`;
}

function plainOverview(account, entry) {
  const isDebt = account.type === 'liability';
  return `
    <div class="goal-hero">
      <div style="display:grid;justify-items:center;margin:8px 0 14px">${badge(isDebt ? 'Debt' : account.category, 'large')}</div>
      <p class="stat-label">${isDebt ? 'Owed' : 'Value'}</p>
      <p class="stat-big${isDebt && entry.valuePence > 0 ? ' is-negative' : ''}">${esc(formatMoney(isDebt ? -entry.valuePence : entry.valuePence))}</p>
      ${account.type === 'quantity' ? `<p class="muted" style="font-size:14.5px;margin-top:4px">${esc(formatUnits(entry.unitsE8, 8))} ${esc(account.unit || 'units')} at ${esc(formatMoney(entry.pricePence))}</p>` : ''}
      ${account.archived ? '' : `<button type="button" class="button is-small" style="margin-top:16px" data-action="edit-goal" data-arg="${esc(account.id)}">${icon.flag}Set a goal</button>`}
    </div>`;
}

function renderAccount() {
  const host = byId('view-account');
  const account = accountById(app.accountId);
  if (!account) return;
  const today = todayISO();
  const entry = balancesAt(app.state, today).get(account.id) || { valuePence: 0, unitsE8: 0, pricePence: 0 };
  const isDebt = account.type === 'liability';
  const isQuantity = account.type === 'quantity';
  const txs = sortedTransactions(app.state).filter((t) => t.accountId === account.id).reverse();
  const ordered = activeAccounts(app.state);
  const position = ordered.findIndex((a) => a.id === account.id);
  const tab = app.accountTab;

  let panel;
  if (tab === 'records') {
    panel = txs.length
      ? `<div class="list-group">${txs.map((tx) => recordRow(tx, account, { showAccount: false })).join('')}</div>
         <p class="page-intro" style="margin-top:12px">${txs.length} entr${txs.length === 1 ? 'y' : 'ies'}. Tap one to change or delete it.</p>`
      : `<div class="empty"><p class="empty-title">No entries yet</p>
          <p class="empty-body">Every amount added to or taken from ${esc(account.name)} is listed here.</p>
          <button type="button" class="button is-primary" data-action="new-tx" data-arg="${esc(account.id)}" data-dir="in">${icon.plus}Add the first entry</button></div>`;
  } else {
    const head = account.goal && !account.archived ? goalOverview(account, entry, today) : plainOverview(account, entry);

    let payoff = '';
    if (isDebt && entry.valuePence > 0) {
      const monthly = averageMonthlyRepayment(app.state, account.id, { today, windowMonths: 6 });
      const projection = projectPayoff(entry.valuePence, monthly, account.interestRatePct || 0, today);
      payoff = `<div class="info-card">
        <p class="info-card-title">When it clears</p>
        <p>${projection.months === null
    ? `No payoff date can be worked out: ${esc(projection.reason)}.${monthly > 0 ? ` You are paying about ${esc(formatMoney(monthly))} a month.` : ''}`
    : `At ${esc(formatMoney(monthly))} a month${account.interestRatePct ? ` and ${esc(account.interestRatePct)}% interest` : ''}, this clears in ${projection.months} month${projection.months === 1 ? '' : 's'}, around ${esc(longDate(projection.payoffDate))}.${projection.totalInterestPence ? ` That includes about ${esc(formatMoney(projection.totalInterestPence))} of interest.` : ''}`}</p>
      </div>`;
    }

    let holding = '';
    if (isQuantity) {
      holding = `<div class="info-card">
        <p class="info-card-title">Holding</p>
        <dl class="info-grid">
          <div><dt>Held</dt><dd>${esc(formatUnits(entry.unitsE8, 8))} ${esc(account.unit || 'units')}</dd></div>
          <div><dt>Price per ${esc(account.unit || 'unit')}</dt><dd>${esc(formatMoney(account.unitPricePence || 0))}</dd></div>
        </dl>
        <div class="price-editor">
          <div class="field">
            <label for="unit-price">New price</label>
            <input class="input" id="unit-price" type="text" inputmode="decimal" autocomplete="off"
                   value="${esc(((account.unitPricePence || 0) / 100).toFixed(2))}">
          </div>
          <button type="button" class="button is-primary" data-action="save-price" data-arg="${esc(account.id)}">Save</button>
        </div>
        <p class="field-hint" id="price-hint" style="margin-top:8px">${account.priceUpdatedAt
    ? `Updated ${esc(longDate(account.priceUpdatedAt))}, ${esc(account.priceSource === 'live' ? 'from the price service' : 'typed in')}.`
    : 'Never set. Type the price today, or the price you paid.'}</p>
      </div>`;
    }

    panel = `
      ${head}
      ${account.archived ? '' : `<div class="quick-actions">
        <button type="button" class="button is-primary" data-action="new-tx" data-arg="${esc(account.id)}" data-dir="in">${icon.plus}${isDebt ? 'Add to debt' : 'Add money'}</button>
        <button type="button" class="button" data-action="new-tx" data-arg="${esc(account.id)}" data-dir="out">${icon.minus}${isDebt ? 'Repay' : 'Withdraw'}</button>
      </div>`}
      <div class="info-card" id="account-chart-card">
        <p class="info-card-title">${isDebt ? 'Owed over time' : 'Value over time'}</p>
        <p class="hero-readout" data-readout data-default="Touch the line to see any day" style="margin-top:0">Touch the line to see any day</p>
        <div data-scrub id="account-chart"></div>
      </div>
      ${holding}
      ${payoff}
      <div class="section-head"><h2 class="section-title">Manage</h2></div>
      <div class="list-group">
        ${account.goal ? settingsRow({ action: 'edit-goal', arg: account.id, glyph: icon.flag, title: 'Edit goal' }) : ''}
        ${account.goal ? settingsRow({ action: 'clear-goal', arg: account.id, glyph: icon.close, title: 'Remove goal' }) : ''}
        ${settingsRow({ action: 'edit-account', arg: account.id, glyph: icon.edit, title: 'Edit account', sub: 'Name, category, unit or interest rate' })}
        ${account.archived ? '' : `
          <button type="button" class="list-row" data-action="move-account" data-arg="${esc(account.id)}" data-dir="up" ${position <= 0 ? 'disabled' : ''}>
            <span class="row-icon">${icon.up}</span><span class="row-main"><span class="row-title">Move up the list</span></span><span></span></button>
          <button type="button" class="list-row" data-action="move-account" data-arg="${esc(account.id)}" data-dir="down" ${position === -1 || position === ordered.length - 1 ? 'disabled' : ''}>
            <span class="row-icon">${icon.down}</span><span class="row-main"><span class="row-title">Move down the list</span></span><span></span></button>`}
        ${settingsRow({ action: 'toggle-archive', arg: account.id, glyph: icon.archive, title: account.archived ? 'Restore' : 'Archive', sub: account.archived ? 'Back into your totals' : 'Keeps its history, out of totals' })}
        ${settingsRow({ action: 'delete-account', arg: account.id, glyph: icon.trash, title: 'Delete this account', danger: true })}
      </div>`;
  }

  host.innerHTML = `
    <div class="detail-bar"><div class="detail-bar-inner">
      <button type="button" class="icon-button" data-action="back" aria-label="Back">${icon.back}</button>
      <h1 class="detail-title">${esc(account.name)}</h1>
      <button type="button" class="icon-button" data-action="edit-account" data-arg="${esc(account.id)}" aria-label="Edit ${esc(account.name)}">${icon.edit}</button>
    </div></div>
    <div class="tabs" role="tablist">
      <button type="button" role="tab" data-action="account-tab" data-tab="overview" aria-selected="${tab === 'overview'}">${account.goal ? 'Goal' : 'Overview'}</button>
      <button type="button" role="tab" data-action="account-tab" data-tab="records" aria-selected="${tab === 'records'}">Records</button>
    </div>
    <div role="tabpanel">${panel}</div>`;

  const chartHost = byId('account-chart');
  if (chartHost) {
    const series = accountSeries(app.state, account.id, { today }).map((p) => ({ date: p.date, value: p.valuePence }));
    if (series.length >= 2) {
      chartHost.innerHTML = lineChart({ series, width: contentWidth(chartHost), height: 150, label: `${account.name} over time` });
      attachScrub(chartHost, byId('account-chart-card').querySelector('[data-readout]'));
    } else {
      const card = byId('account-chart-card');
      card.querySelector('[data-readout]').remove();
      chartHost.innerHTML = '<div class="chart-empty"><p class="chart-empty-title">Not enough history yet</p><p class="chart-empty-hint">The line appears once there are entries on two different days.</p></div>';
    }
  }
}

/* ------------------------------------------------------------------ */
/* Crosshair scrubbing on line charts                                  */
/* ------------------------------------------------------------------ */

function attachScrub(container, readout) {
  if (!container || !readout) return;
  const svg = container.querySelector('svg[data-points]');
  if (!svg) return;
  let points;
  try { points = JSON.parse(svg.dataset.points); } catch { return; }
  if (!points.length) return;
  const group = svg.querySelector('.crosshair-group');
  const line = group.querySelector('line');
  const dot = group.querySelector('circle');
  let index = points.length - 1;

  const show = (i) => {
    index = Math.max(0, Math.min(points.length - 1, i));
    const [x, y, date, value] = points[index];
    line.setAttribute('x1', x);
    line.setAttribute('x2', x);
    dot.setAttribute('cx', x);
    dot.setAttribute('cy', y);
    group.setAttribute('visibility', 'visible');
    readout.textContent = '';
    const strong = document.createElement('strong');
    strong.textContent = formatMoney(value);
    readout.append(strong, document.createTextNode(` on ${longDate(date)}`));
  };
  const nearest = (clientX) => {
    const box = svg.getBoundingClientRect();
    const scale = svg.viewBox.baseVal.width / (box.width || 1);
    const x = (clientX - box.left) * scale;
    let best = 0;
    for (let i = 1; i < points.length; i += 1) {
      if (Math.abs(points[i][0] - x) < Math.abs(points[best][0] - x)) best = i;
    }
    return best;
  };
  const reset = () => {
    group.setAttribute('visibility', 'hidden');
    readout.textContent = readout.dataset.default || '';
  };

  svg.setAttribute('tabindex', '0');
  svg.addEventListener('pointerdown', (e) => show(nearest(e.clientX)));
  svg.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse' || e.buttons || e.pressure > 0) show(nearest(e.clientX));
  });
  svg.addEventListener('pointerleave', reset);
  svg.addEventListener('pointercancel', reset);
  svg.addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') window.setTimeout(reset, 1400); });
  svg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); show(index - 1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); show(index + 1); }
    if (e.key === 'Home') { e.preventDefault(); show(0); }
    if (e.key === 'End') { e.preventDefault(); show(points.length - 1); }
    if (e.key === 'Escape') reset();
  });
  svg.addEventListener('blur', reset);
}

/* ------------------------------------------------------------------ */
/* Navigation                                                          */
/* ------------------------------------------------------------------ */

function goTo(view) {
  if (app.view === 'account' && history.state && history.state.phthalo === 'account') {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  app.view = view;
  app.accountId = null;
  render();
  window.scrollTo(0, 0);
}

function openAccount(id, tab = 'overview') {
  if (!accountById(id)) return;
  if (app.sheetOpen) closeSheet();
  if (app.view !== 'account') {
    app.previousView = app.view;
    history.pushState({ phthalo: 'account', id }, '', '#account');
  } else {
    history.replaceState({ phthalo: 'account', id }, '', '#account');
  }
  app.view = 'account';
  app.accountId = id;
  app.accountTab = tab;
  render();
  window.scrollTo(0, 0);
}

function leaveAccount() {
  app.view = TAB_VIEWS.includes(app.previousView) ? app.previousView : 'home';
  app.accountId = null;
  render();
  window.scrollTo(0, 0);
}

// The phone's own back gesture closes a sheet first, then the account screen.
window.addEventListener('popstate', (event) => {
  if (app.sheetOpen) {
    closeSheet();
    if (app.view === 'account' && app.accountId) {
      history.pushState({ phthalo: 'account', id: app.accountId }, '', '#account');
    }
    return;
  }
  const st = event.state;
  if (st && st.phthalo === 'account' && accountById(st.id)) {
    app.view = 'account';
    app.accountId = st.id;
    render();
  } else if (app.view === 'account') {
    leaveAccount();
  }
});

/* ------------------------------------------------------------------ */
/* Sheet                                                               */
/* ------------------------------------------------------------------ */

let lastFocus = null;

function openSheet(title, html) {
  if (!app.sheetOpen) lastFocus = document.activeElement;
  const sheet = byId('sheet');
  sheet.innerHTML = `
    <div class="sheet-grab" aria-hidden="true"></div>
    <div class="sheet-head">
      <h2 class="sheet-title" id="sheet-title">${esc(title)}</h2>
      <button type="button" class="icon-button" data-action="close-sheet" aria-label="Close">${icon.close}</button>
    </div>
    ${html}`;
  byId('sheet-backdrop').hidden = false;
  app.sheetOpen = true;
  const focusable = sheet.querySelector('input:not([type="hidden"]), select, textarea');
  if (focusable && window.matchMedia('(pointer: fine)').matches) focusable.focus();
  else sheet.focus({ preventScroll: true });
  sheet.scrollTop = 0;
}

function closeSheet() {
  byId('sheet-backdrop').hidden = true;
  byId('sheet').innerHTML = '';
  app.sheetOpen = false;
  if (lastFocus && document.body.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
  lastFocus = null;
}

function confirmSheet({ title, body, confirmLabel, danger = false, extraAction = null, onConfirm }) {
  app.pendingConfirm = onConfirm;
  openSheet(title, `
    <p class="sheet-body">${esc(body)}</p>
    ${extraAction ? `<button type="button" class="button is-block" data-action="${esc(extraAction.action)}" style="margin-bottom:10px">${icon.download}${esc(extraAction.label)}</button>` : ''}
    <div class="form-actions" style="margin-top:0">
      <button type="button" class="button" data-action="close-sheet">Cancel</button>
      <button type="button" class="button ${danger ? 'is-danger' : 'is-primary'}" data-action="run-confirm">${esc(confirmLabel)}</button>
    </div>`);
}

/* ------------------------------------------------------------------ */
/* Forms                                                               */
/* ------------------------------------------------------------------ */

function accountPicker() {
  const today = todayISO();
  const balances = balancesAt(app.state, today);
  const accounts = activeAccounts(app.state);
  if (!accounts.length) { accountForm(null); return; }
  openSheet('Add an entry to', `
    <div class="list-group">
      ${accounts.map((a) => {
    const entry = balances.get(a.id) || { valuePence: 0 };
    const isDebt = a.type === 'liability';
    return `<button type="button" class="list-row" data-action="new-tx" data-arg="${esc(a.id)}" data-dir="in">
          ${badge(isDebt ? 'Debt' : a.category, 'small')}
          <span class="row-main"><span class="row-title">${esc(a.name)}</span><span class="row-sub">${esc(a.category)}</span></span>
          <span class="row-end"><span class="row-amount">${esc(formatMoney(isDebt ? -entry.valuePence : entry.valuePence))}</span></span>
        </button>`;
  }).join('')}
    </div>`);
}

function accountForm(accountId) {
  const existing = accountId ? accountById(accountId) : null;
  const a = existing || { id: null, name: '', type: 'balance', category: 'Cash', unit: '', unitPricePence: 0, interestRatePct: '', note: '' };

  openSheet(existing ? `Edit ${existing.name}` : 'Add an account', `
    <form data-form="account" data-arg="${esc(accountId || '')}" novalidate>
      <div class="field">
        <label for="acc-name">Name</label>
        <input class="input" id="acc-name" name="name" type="text" value="${esc(a.name)}" maxlength="60" autocomplete="off" required>
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
            <input class="input" id="acc-unit" name="unit" type="text" value="${esc(a.unit || '')}" placeholder="BTC, oz" maxlength="12" autocomplete="off">
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
               value="${esc(a.interestRatePct === '' || a.interestRatePct === undefined ? '' : a.interestRatePct)}" placeholder="6.9">
        <p class="field-hint">Used to work out when the debt clears at your current payments.</p>
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
  typeSelect.addEventListener('change', () => {
    const value = typeSelect.value;
    document.querySelectorAll('[data-when-type]').forEach((el) => { el.hidden = el.dataset.whenType !== value; });
    const categorySelect = byId('acc-category');
    if (value === 'liability') categorySelect.value = 'Debt';
    else if (categorySelect.value === 'Debt') categorySelect.value = 'Cash';
  });
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
  const outLabel = isDebt ? 'Repay' : 'Withdraw';
  const price = existing && existing.unitPricePence ? existing.unitPricePence : (account.unitPricePence || entry.pricePence || 0);

  openSheet(existing ? 'Edit entry' : account.name, `
    <form data-form="transaction" data-arg="${esc(existing ? existing.id : '')}" data-account="${esc(account.id)}" novalidate>
      <div class="field">
        <div class="segmented" role="group" aria-label="Direction">
          <button type="button" data-set-direction="in" aria-pressed="${dir === 'in'}">${esc(inLabel)}</button>
          <button type="button" data-set-direction="out" aria-pressed="${dir === 'out'}">${esc(outLabel)}</button>
        </div>
        <input type="hidden" name="direction" value="${esc(dir)}">
      </div>
      ${isQuantity ? `
        <div class="field">
          <span class="field-label" id="mode-label">Record this in</span>
          <div class="segmented" role="group" aria-labelledby="mode-label">
            <button type="button" data-set-mode="money" aria-pressed="true">Pounds</button>
            <button type="button" data-set-mode="units" aria-pressed="false">${esc(account.unit || 'Units')}</button>
          </div>
          <input type="hidden" name="mode" value="money">
        </div>` : ''}
      <div class="field" data-mode-field="money">
        <label for="tx-amount">Amount</label>
        <input class="input input-money" id="tx-amount" name="amount" type="text" inputmode="decimal"
               value="${esc(existing ? (existing.amountPence / 100).toFixed(2) : '')}" placeholder="£0.00" autocomplete="off">
        <p class="field-error" data-error="amount" hidden></p>
      </div>
      ${isQuantity ? `
        <div class="field" data-mode-field="units" hidden>
          <label for="tx-units">Quantity in ${esc(account.unit || 'units')}</label>
          <input class="input input-money" id="tx-units" name="units" type="text" inputmode="decimal"
                 value="${esc(existing && existing.unitsE8 ? formatUnits(existing.unitsE8, 8) : '')}" placeholder="0.00000000" autocomplete="off">
          <p class="field-error" data-error="units" hidden></p>
        </div>
        <div class="field">
          <label for="tx-price">Price per ${esc(account.unit || 'unit')} on that day</label>
          <input class="input" id="tx-price" name="unitPrice" type="text" inputmode="decimal" value="${esc(price ? (price / 100).toFixed(2) : '')}" autocomplete="off">
          <p class="field-hint">Converts between pounds and ${esc(account.unit || 'units')}, and values the holding on that day.</p>
          <p class="field-error" data-error="unitPrice" hidden></p>
        </div>` : ''}
      <div class="field-row">
        <div class="field">
          <label for="tx-date">Date</label>
          <input class="input" id="tx-date" name="date" type="date" value="${esc(existing ? existing.date : today)}" max="${esc(today)}">
          <p class="field-error" data-error="date" hidden></p>
        </div>
        <div class="field">
          <label for="tx-note">Note</label>
          <input class="input" id="tx-note" name="note" type="text" value="${esc(existing ? existing.note : '')}" maxlength="120" autocomplete="off" placeholder="Optional">
        </div>
      </div>
      <p class="field-hint" style="margin-top:-8px">Backdate freely. Every chart puts the entry in its right place.</p>
      <p class="field-error" data-error="form" hidden style="margin-top:12px"></p>
      <div class="form-actions">
        <button type="button" class="button" data-action="close-sheet">Cancel</button>
        <button type="submit" class="button is-primary">${existing ? 'Save changes' : 'Save'}</button>
      </div>
      ${existing ? `<button type="button" class="button is-danger is-block" style="margin-top:10px"
          data-action="delete-tx" data-arg="${esc(existing.id)}">${icon.trash}Delete this entry</button>` : ''}
    </form>`);

  const sheet = byId('sheet');
  sheet.querySelectorAll('[data-set-direction]').forEach((button) => {
    button.addEventListener('click', () => {
      sheet.querySelectorAll('[data-set-direction]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
      button.setAttribute('aria-pressed', 'true');
      sheet.querySelector('input[name="direction"]').value = button.dataset.setDirection;
      const form = sheet.querySelector('form');
      form.dataset.forceNext = '';
      setFieldError(form, 'form', '');
    });
  });
  sheet.querySelectorAll('[data-set-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      const mode = button.dataset.setMode;
      sheet.querySelectorAll('[data-set-mode]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
      button.setAttribute('aria-pressed', 'true');
      sheet.querySelector('input[name="mode"]').value = mode;
      sheet.querySelectorAll('[data-mode-field]').forEach((field) => { field.hidden = field.dataset.modeField !== mode; });
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
      ${isDebt ? '<p class="sheet-body">For a debt the goal is a payoff date. The target is normally zero, meaning cleared in full.</p>' : ''}
      <div class="field">
        <label for="goal-target">${esc(isDebt ? 'Target balance, normally 0' : 'Target amount')}</label>
        <input class="input input-money" id="goal-target" name="target" type="text" inputmode="decimal"
               value="${esc(goal ? (goal.targetPence / 100).toFixed(2) : (isDebt ? '0.00' : ''))}" placeholder="£0.00" autocomplete="off">
        <p class="field-error" data-error="target" hidden></p>
      </div>
      <div class="field">
        <label for="goal-date">Target date</label>
        <input class="input" id="goal-date" name="date" type="date" value="${esc(goal && goal.targetDate ? goal.targetDate : addDays(today, 365))}">
        <p class="field-error" data-error="date" hidden></p>
      </div>
      <div class="field">
        <label for="goal-start">Starting point</label>
        <input class="input" id="goal-start" name="start" type="text" inputmode="decimal"
               value="${esc(goal ? (goal.startPence / 100).toFixed(2) : (entry.valuePence / 100).toFixed(2))}" autocomplete="off">
        <p class="field-hint">Where you were when the goal began. The pace check draws a straight line from here.</p>
        <p class="field-error" data-error="start" hidden></p>
      </div>
      <div class="form-actions">
        <button type="button" class="button" data-action="close-sheet">Cancel</button>
        <button type="submit" class="button is-primary">Save goal</button>
      </div>
    </form>`);
}

function galleryForm() {
  const visuals = app.state.visuals.filter((v) => VISUAL_LIBRARY[v.id]);
  const on = visuals.filter((v) => v.enabled).length;
  openSheet('Charts', `
    <p class="sheet-body">Switch charts on and off, and use the arrows to put them in the order you want.
      ${on} of ${visuals.length} showing.</p>
    <div class="list-group">
      ${visuals.map((visual, index) => {
    const meta = VISUAL_LIBRARY[visual.id];
    return `
        <div class="gallery-item">
          <div><p class="gallery-name">${esc(meta.name)}</p><p class="gallery-blurb">${esc(meta.blurb)}</p></div>
          <button type="button" class="icon-button" data-action="move-visual" data-arg="${esc(visual.id)}" data-dir="up"
                  ${index === 0 ? 'disabled' : ''} aria-label="Move ${esc(meta.name)} up">${icon.up}</button>
          <button type="button" class="icon-button" data-action="move-visual" data-arg="${esc(visual.id)}" data-dir="down"
                  ${index === visuals.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(meta.name)} down">${icon.down}</button>
          <button type="button" class="toggle" data-action="toggle-visual" data-arg="${esc(visual.id)}"
                  aria-pressed="${visual.enabled}" aria-label="${esc(meta.name)} ${visual.enabled ? 'on' : 'off'}">${visual.enabled ? 'On' : 'Off'}</button>
        </div>`;
  }).join('')}
    </div>
    <div class="form-actions"><button type="button" class="button is-primary" data-action="close-sheet">Done</button></div>`);
}

/* ------------------------------------------------------------------ */
/* Form validation and submission                                      */
/* ------------------------------------------------------------------ */

function setFieldError(form, name, message) {
  const holder = form.querySelector(`[data-error="${name}"]`);
  const input = form.querySelector(`[name="${name}"]`);
  if (holder) { holder.textContent = message || ''; holder.hidden = !message; }
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
  if (app.state.accounts.some((a) => a.id !== id && a.name.toLowerCase() === name.toLowerCase())) {
    setFieldError(form, 'name', 'Another account already has that name.');
    return;
  }

  const type = existing ? existing.type : String(data.get('type') || 'balance');
  const category = type === 'liability' ? 'Debt' : String(data.get('category') || 'Cash');

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

  let newId = null;
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
      newId = nextId('acc');
      const account = {
        id: newId,
        name,
        type,
        category,
        order: draft.accounts.length,
        colourIndex: 0,
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
      if (type === 'liability' && interestRatePct !== undefined) account.interestRatePct = interestRatePct;
      draft.accounts.push(account);
    }
  }, { silent: true });

  closeSheet();
  render();
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
  if (!isValidISODate(date)) { setFieldError(form, 'date', 'That is not a real date.'); return; }
  const today = todayISO();
  if (date > today) { setFieldError(form, 'date', 'Entries cannot be dated in the future.'); return; }

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
    const entry = balancesAt(app.state, today).get(account.id) || { valuePence: 0 };
    const currentValue = txId ? entry.valuePence - originalSignedValue(txId) : entry.valuePence;
    const check = checkWithdrawal(account, currentValue, amountPence);
    if (!check.ok) {
      setFieldError(form, 'form', `${check.warning} Press save again to record it anyway.`);
      form.dataset.forceNext = '1';
      return;
    }
  }

  commit((draft) => {
    const note = String(data.get('note') || '').trim();
    if (txId) {
      const target = draft.transactions.find((t) => t.id === txId);
      Object.assign(target, { direction, amountPence, unitsE8, unitPricePence, date, note });
    } else {
      draft.transactions.push({
        id: nextId('tx'),
        accountId: account.id,
        date,
        direction,
        amountPence,
        unitsE8,
        unitPricePence,
        note,
        createdAt: new Date().toISOString()
      });
    }
  }, { silent: true });

  closeSheet();
  render();
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
  }, { silent: true });
  closeSheet();
  app.accountTab = 'overview';
  render();
}

/* ------------------------------------------------------------------ */
/* Export and import                                                   */
/* ------------------------------------------------------------------ */

function exportJson() {
  const today = todayISO();
  const result = store.downloadText(store.exportFilename(today, 'json'), store.toExportJson(app.state), 'application/json');
  if (!result.ok) {
    addBanner({ kind: 'error', title: 'The export did not start', body: result.message });
    return;
  }
  dropBanners('backup-reminder');
  commit((draft) => { draft.lastExportAt = today; });
  addBanner({
    kind: 'success', key: 'exported', title: 'Backup downloaded',
    body: 'Keep that file somewhere safe. Importing it later restores everything exactly.'
  });
}

function exportCsv() {
  const result = store.downloadText(store.exportFilename(todayISO(), 'csv'), transactionsToCsv(app.state), 'text/csv');
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
    reader.onerror = () => addBanner({ kind: 'error', title: 'That file could not be read', body: 'Try exporting it again.' });
    reader.onload = () => {
      const parsed = store.parseImport(String(reader.result || ''), todayISO());
      if (!parsed.ok) {
        addBanner({ kind: 'error', title: 'That file was not imported', body: `Nothing has changed. ${parsed.errors.join(' ')}` });
        return;
      }
      confirmSheet({
        title: 'Import this backup?',
        body: `The file holds ${parsed.state.accounts.length} accounts and ${parsed.state.transactions.length} entries. `
          + 'Importing replaces everything currently in the app. Export what you have first if you are not sure.',
        confirmLabel: 'Replace my data',
        extraAction: { label: 'Export what I have first', action: 'export-json' },
        onConfirm: () => {
          app.state = parsed.state;
          const saved = store.save(app.state);
          closeSheet();
          app.view = 'home';
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
  addBanner({ kind: 'info', key: 'price-refresh', title: 'Checking prices', body: 'This takes a few seconds at most.', dismissible: false });
  try {
    const result = await fetchPrices(app.state.accounts);
    dropBanners('price-refresh');
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
    dropBanners('price-refresh');
    addBanner({ kind: 'info', title: 'Prices left as they were', body: `The price refresh could not run (${error.message}). Your typed prices are untouched.` });
  } finally {
    refreshing = false;
  }
}

/* ------------------------------------------------------------------ */
/* Theme                                                               */
/* ------------------------------------------------------------------ */

function resolveTheme(setting) {
  if (setting === 'light' || setting === 'dark') return setting;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(setting) {
  const resolved = resolveTheme(setting);
  document.documentElement.setAttribute('data-theme', resolved);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'light' ? '#F2F3F6' : '#0F1013');
}

function watchSystemTheme() {
  if (!window.matchMedia) return;
  const query = window.matchMedia('(prefers-color-scheme: light)');
  const handler = () => {
    if ((app.state.settings.theme || 'system') === 'system') applyTheme('system');
  };
  if (query.addEventListener) query.addEventListener('change', handler);
  else if (query.addListener) query.addListener(handler);
}

/* ------------------------------------------------------------------ */
/* Tooltips                                                            */
/* ------------------------------------------------------------------ */

function showTooltip(target) {
  const value = target.getAttribute('data-tip-value');
  if (!value) return;
  const tooltip = byId('tooltip');
  tooltip.textContent = '';
  const strong = document.createElement('strong');
  strong.textContent = value;
  tooltip.append(strong, document.createTextNode(target.getAttribute('data-tip-label') || ''));
  tooltip.hidden = false;
  const box = target.getBoundingClientRect();
  const size = tooltip.getBoundingClientRect();
  let left = box.left + (box.width / 2) - (size.width / 2);
  left = Math.max(8, Math.min(left, window.innerWidth - size.width - 8));
  let top = box.top - size.height - 10;
  if (top < 8) top = box.bottom + 10;
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
  if (!('serviceWorker' in navigator) || window.location.protocol === 'file:') return;
  navigator.serviceWorker.register('./sw.js').then((registration) => {
    const offer = () => {
      if (!navigator.serviceWorker.controller) return; // a first install, not an update
      addBanner({
        kind: 'info',
        key: 'sw-update',
        title: 'A new version is ready',
        body: 'Reload to pick it up. Your data is not affected.',
        actions: [{ label: 'Reload now', action: 'apply-update', primary: true }]
      });
    };
    const track = (worker) => {
      if (!worker) return;
      worker.addEventListener('statechange', () => { if (worker.state === 'installed') offer(); });
    };
    // The browser may have found and even finished installing an update
    // before this page got here, in which case updatefound has already
    // fired. Catch all three moments, not just the event.
    if (registration.waiting) offer();
    track(registration.installing);
    registration.addEventListener('updatefound', () => track(registration.installing));
  }).catch(() => {
    // Offline support is a bonus, never a reason to break the app.
  });

  // An app left open on a phone may not navigate for days, so check for a
  // new release whenever it comes back into view.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    navigator.serviceWorker.getRegistration().then((r) => r && r.update()).catch(() => {});
  });

  // Only reload when the person asked for the new version. A brand new
  // install also changes the controller, as the worker takes charge of the
  // page, and reloading then would wipe the first run screen for nothing.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!updateRequested || reloading) return;
    reloading = true;
    window.location.reload();
  });
}

let updateRequested = false;
let reloading = false;

function applyUpdate() {
  updateRequested = true;
  if (!('serviceWorker' in navigator)) { window.location.reload(); return; }
  navigator.serviceWorker.getRegistration().then((registration) => {
    if (registration && registration.waiting) registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    else window.location.reload();
  }).catch(() => window.location.reload());
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

const ACTIONS = {
  go(el) { goTo(el.dataset.view); },
  back() {
    if (history.state && history.state.phthalo === 'account') history.back();
    else leaveAccount();
  },
  'account-tab'(el) { app.accountTab = el.dataset.tab; render(); },
  'close-sheet': closeSheet,
  'dismiss-banner'(el) { removeBanner(el.dataset.arg); },

  'dismiss-ios-notice'() {
    dropBanners('ios-storage');
    commit((draft) => { draft.settings.notices.iosStorage = true; });
  },

  'toggle-theme'() {
    const next = resolveTheme(app.state.settings.theme || 'system') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    commit((draft) => { draft.settings.theme = next; });
  },

  'set-theme'(el) {
    const value = el.dataset.value;
    applyTheme(value);
    commit((draft) => { draft.settings.theme = value; });
  },

  'set-range'(el) { commit((draft) => { draft.settings.netWorthRange = el.dataset.range; }); },

  fab() {
    if (app.view === 'account' && app.accountId) transactionForm({ accountId: app.accountId, direction: 'in' });
    else accountPicker();
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
    const inSheet = Boolean(el.closest('#sheet'));
    commit((draft) => {
      const source = draft.visuals;
      const index = source.findIndex((v) => v.id === el.dataset.arg);
      if (index < 0) return;
      let swapWith = index + dir;
      // On the Insights tab, step past charts that are switched off.
      if (!inSheet) {
        while (swapWith >= 0 && swapWith < source.length && !source[swapWith].enabled) swapWith += dir;
      }
      if (swapWith < 0 || swapWith >= source.length) return;
      const [moved] = source.splice(index, 1);
      source.splice(swapWith, 0, moved);
      source.forEach((v, i) => { v.order = i; });
    });
    if (inSheet) galleryForm();
  },

  'add-account'() { accountForm(null); },
  'edit-account'(el) { accountForm(el.dataset.arg); },
  'open-account'(el) { openAccount(el.dataset.arg); },
  'edit-goal'(el) { goalForm(el.dataset.arg); },
  'toggle-archived-list'() { app.showArchived = !app.showArchived; render(); },

  'clear-goal'(el) {
    const id = el.dataset.arg;
    commit((draft) => {
      const account = draft.accounts.find((a) => a.id === id);
      if (account) account.goal = null;
    });
  },

  'move-account'(el) {
    const dir = el.dataset.dir === 'up' ? -1 : 1;
    commit((draft) => {
      const list = draft.accounts.filter((a) => !a.archived).sort((a, b) => a.order - b.order);
      const index = list.findIndex((a) => a.id === el.dataset.arg);
      if (index < 0 || index + dir < 0 || index + dir >= list.length) return;
      const swap = list[index + dir];
      const current = list[index];
      [current.order, swap.order] = [swap.order, current.order];
    });
  },

  'toggle-archive'(el) {
    const id = el.dataset.arg;
    const account = accountById(id);
    const archiving = account && !account.archived;
    commit((draft) => {
      const target = draft.accounts.find((a) => a.id === id);
      if (target) target.archived = !target.archived;
    }, { silent: true });
    if (archiving) {
      leaveAccount();
      addBanner({ kind: 'info', title: `${account.name} archived`, body: 'It keeps its history. Find it again under Settings.' });
    } else {
      render();
    }
  },

  'delete-account'(el) {
    const account = accountById(el.dataset.arg);
    if (!account) return;
    const count = app.state.transactions.filter((t) => t.accountId === account.id).length;
    confirmSheet({
      title: `Delete ${account.name}?`,
      body: `This removes the account and all ${count} of its entries. That history is gone from every chart `
        + 'and cannot be undone. Export a backup first if there is any doubt.',
      confirmLabel: 'Delete it',
      danger: true,
      extraAction: { label: 'Export a backup first', action: 'export-json' },
      onConfirm: () => {
        commit((draft) => {
          draft.accounts = draft.accounts.filter((a) => a.id !== account.id);
          draft.transactions = draft.transactions.filter((t) => t.accountId !== account.id);
          draft.accounts.forEach((a, i) => { a.order = i; });
        }, { silent: true });
        closeSheet();
        if (app.view === 'account') leaveAccount(); else render();
        addBanner({ kind: 'info', title: 'Account deleted', body: `${account.name} and its ${count} entries have been removed.` });
      }
    });
  },

  'new-tx'(el) { transactionForm({ accountId: el.dataset.arg, direction: el.dataset.dir || 'in' }); },
  'edit-tx'(el) { transactionForm({ txId: el.dataset.arg }); },

  'delete-tx'(el) {
    const tx = app.state.transactions.find((t) => t.id === el.dataset.arg);
    if (!tx) return;
    const account = accountById(tx.accountId);
    confirmSheet({
      title: 'Delete this entry?',
      body: `${formatMoney(tx.amountPence)} ${tx.direction === 'out' ? 'out of' : 'into'} `
        + `${account ? account.name : 'a deleted account'} on ${longDate(tx.date)}. Every chart will be redrawn without it.`,
      confirmLabel: 'Delete it',
      danger: true,
      onConfirm: () => {
        commit((draft) => { draft.transactions = draft.transactions.filter((t) => t.id !== tx.id); }, { silent: true });
        closeSheet();
        render();
      }
    });
  },

  'save-price'(el) {
    const account = accountById(el.dataset.arg);
    const input = byId('unit-price');
    if (!account || !input) return;
    const parsed = parseMoneyToPence(input.value, { allowZero: true });
    if (!parsed.ok) {
      const hint = byId('price-hint');
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
  },

  'export-json': exportJson,
  'export-csv': exportCsv,
  'export-damaged': exportDamaged,
  'import-json': importJson,

  'load-demo'() {
    confirmSheet({
      title: 'Load the demo data?',
      body: 'This replaces everything currently in the app with twelve months of made up activity, so you can see every chart working.',
      confirmLabel: 'Load it',
      extraAction: app.state.transactions.length ? { label: 'Export what I have first', action: 'export-json' } : null,
      onConfirm: () => {
        const next = demoState(todayISO());
        app.state = next;
        store.save(app.state);
        closeSheet();
        dropBanners('welcome');
        app.view = 'home';
        render();
        window.scrollTo(0, 0);
        addBanner({
          kind: 'success', title: 'Demo data loaded',
          body: `${next.transactions.length} entries across ${next.accounts.length} accounts. Clear it in Settings when you have finished looking.`
        });
      }
    });
  },

  'clear-all'() {
    confirmSheet({
      title: 'Clear everything?',
      body: 'Every account, entry and goal is removed from this browser and cannot be recovered without a backup file. The ten starting accounts come back empty.',
      confirmLabel: 'Clear it all',
      danger: true,
      extraAction: app.state.transactions.length ? { label: 'Export a backup first', action: 'export-json' } : null,
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

  'recovery-reload'() { window.location.reload(); },

  'run-confirm'() {
    const handler = app.pendingConfirm;
    app.pendingConfirm = null;
    if (typeof handler === 'function') handler();
  }
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
  if (target.disabled) return;
  const handler = ACTIONS[target.dataset.action];
  if (typeof handler !== 'function') return;
  event.preventDefault();
  hideTooltip();
  try {
    handler(target);
  } catch (error) {
    addBanner({ kind: 'error', title: 'That did not work', body: `${error.message}. Nothing has been changed.` });
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
    addBanner({ kind: 'error', title: 'That could not be saved', body: `${error.message}. Nothing has been changed.` });
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  hideTooltip();
  if (app.sheetOpen) closeSheet();
});

// Tooltips on hover, on focus and on tap.
document.addEventListener('pointerover', (event) => {
  const target = event.target.closest && event.target.closest('[data-tip-value]');
  if (target) showTooltip(target);
});
document.addEventListener('pointerout', (event) => {
  if (event.target.closest && event.target.closest('[data-tip-value]')) hideTooltip();
});
document.addEventListener('focusin', (event) => {
  const target = event.target.closest && event.target.closest('[data-tip-value]');
  if (target) showTooltip(target);
});
document.addEventListener('focusout', hideTooltip);
document.addEventListener('scroll', hideTooltip, { passive: true });

let resizeTimer = null;
window.addEventListener('resize', () => {
  if (resizeTimer) window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    if (Math.abs(window.innerWidth - app.lastWidth) > 8) render();
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
