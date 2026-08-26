/**
 * logic.js
 *
 * Every calculation in the application lives here as a pure function.
 * Nothing in this file touches the DOM, localStorage, the network or the
 * system clock. Anything that needs "today" takes it as an argument, so
 * every function can be tested with a fixed date.
 *
 * Money is always an integer number of pence. Dates are always
 * "YYYY-MM-DD" strings. Quantities are integers scaled by 1e8 (so one
 * whole unit is 100000000) which is enough precision for Bitcoin.
 */

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

export const SCHEMA_VERSION = 1;
export const STORAGE_KEY = 'phthalo.finance.v1';
export const BACKUP_KEY = 'phthalo.finance.v1.backup';
export const UNIT_SCALE = 100000000; // 1e8

export const ACCOUNT_TYPES = ['quantity', 'balance', 'liability'];

export const DAYS_PER_MONTH = 30.436875; // mean Gregorian month

export const CATEGORIES = [
  'Crypto',
  'Precious metals',
  'Property savings',
  'Investments',
  'Cash',
  'Debt'
];

/** The Phthalo Blue scale, darkest to lightest. */
export const PHTHALO_SCALE = [
  { token: 'phthalo-950', hex: '#000F26' },
  { token: 'phthalo-900', hex: '#001B3D' },
  { token: 'phthalo-800', hex: '#002B5C' },
  { token: 'phthalo-700', hex: '#003D7A' },
  { token: 'phthalo-600', hex: '#005098' },
  { token: 'phthalo-500', hex: '#0068B3' },
  { token: 'phthalo-400', hex: '#2E8ECB' },
  { token: 'phthalo-300', hex: '#6BB3DE' },
  { token: 'phthalo-200', hex: '#A8D3EC' },
  { token: 'phthalo-100', hex: '#D6E9F6' },
  { token: 'phthalo-050', hex: '#EEF6FC' }
];

export const SUPPORTING_COLOURS = {
  ink: '#0A1420',
  muted: '#5B6B7C',
  surface: '#FFFFFF',
  canvas: '#F4F8FB',
  positive: '#1E8C6E',
  negative: '#C1452F',
  accent: '#E0A33D'
};

/**
 * Text safe variants.
 *
 * The three supporting colours were specified for fills. Measured against
 * white, --positive comes out at 4.17 to 1 and --accent at 2.22 to 1, so
 * neither reaches WCAG AA for body text. These darkened and lightened
 * versions keep the same hue and saturation and are what the interface
 * uses whenever one of those colours carries text. The original values are
 * still used for chart fills, where the AA body text rule does not apply.
 */
export const THEME_COLOURS = {
  light: {
    ink: '#0A1420',
    muted: '#5B6B7C',
    surface: '#FFFFFF',
    canvas: '#F4F8FB',
    positive: '#1E8C6E',
    negative: '#C1452F',
    accent: '#E0A33D',
    positiveText: '#1B7E63',
    negativeText: '#C1452F',
    accentText: '#966617'
  },
  dark: {
    ink: '#EEF6FC',
    muted: '#8FB4CE',
    surface: '#001B3D',
    canvas: '#000F26',
    positive: '#1E8C6E',
    negative: '#C1452F',
    accent: '#E0A33D',
    positiveText: '#209475',
    negativeText: '#D4614D',
    accentText: '#E0A33D'
  }
};

/** Reserved for the debt so it is never mistaken for an asset. */
export const LIABILITY_COLOUR = SUPPORTING_COLOURS.negative;

/* ------------------------------------------------------------------ */
/* Colour utilities                                                    */
/*                                                                     */
/* These exist so the palette claims in the documentation can actually */
/* be measured in the test suite rather than assumed.                  */
/* ------------------------------------------------------------------ */

export function hexToRgb(hex) {
  const m = String(hex).trim().replace(/^#/, '');
  const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`Not a hex colour: ${hex}`);
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16)
  };
}

/** WCAG relative luminance, 0 to 1. */
export function relativeLuminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const channel = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two colours, 1 to 21. */
export function contrastRatio(hexA, hexB) {
  const a = relativeLuminance(hexA);
  const b = relativeLuminance(hexB);
  const light = Math.max(a, b);
  const dark = Math.min(a, b);
  return (light + 0.05) / (dark + 0.05);
}

/** HSL lightness as a percentage, 0 to 100. */
export function lightnessOf(hex) {
  const { r, g, b } = hexToRgb(hex);
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  return ((max + min) / 2) * 100;
}

/** Smallest lightness gap between any two colours in a list. */
export function minimumLightnessGap(hexes) {
  if (hexes.length < 2) return Infinity;
  let smallest = Infinity;
  for (let i = 0; i < hexes.length; i += 1) {
    for (let j = i + 1; j < hexes.length; j += 1) {
      smallest = Math.min(smallest, Math.abs(lightnessOf(hexes[i]) - lightnessOf(hexes[j])));
    }
  }
  return smallest;
}

/**
 * How many slots on the scale each category is allowed, walking down from
 * the darkest shade. Accounts inside one category get neighbouring shades
 * so the category reads as a family, which is the assignment rule agreed
 * for this palette.
 */
export const CATEGORY_SLOT_START = {
  Crypto: 0,             // phthalo-950, 900, 800
  'Precious metals': 3,  // phthalo-700, 600
  'Property savings': 5, // phthalo-500
  Investments: 6,        // phthalo-400
  Cash: 7,               // phthalo-300, 200
  Debt: -1               // always the liability red
};

/**
 * Work out a fixed colour slot for every account by walking down the
 * phthalo scale in category order. Deterministic, so an account keeps the
 * same colour for as long as it exists.
 */
export function assignAccountColours(accounts) {
  const order = CATEGORIES.filter((c) => c !== 'Debt');
  const used = new Set();
  const result = new Map();

  for (const category of order) {
    const members = accounts
      .filter((a) => a.category === category && a.type !== 'liability')
      .sort((a, b) => (a.order - b.order));
    let slot = CATEGORY_SLOT_START[category] === undefined ? 0 : CATEGORY_SLOT_START[category];
    for (const account of members) {
      while (used.has(slot) && slot < PHTHALO_SCALE.length) slot += 1;
      if (slot >= PHTHALO_SCALE.length) {
        // Ran off the end of the scale, fall back to the first free slot.
        slot = 0;
        while (used.has(slot) && slot < PHTHALO_SCALE.length) slot += 1;
      }
      used.add(slot);
      result.set(account.id, slot % PHTHALO_SCALE.length);
      slot += 1;
    }
  }

  // Anything left over, including unknown categories.
  for (const account of accounts) {
    if (account.type === 'liability' || result.has(account.id)) continue;
    let slot = 0;
    while (used.has(slot) && slot < PHTHALO_SCALE.length) slot += 1;
    if (slot >= PHTHALO_SCALE.length) slot = accounts.indexOf(account) % PHTHALO_SCALE.length;
    used.add(slot);
    result.set(account.id, slot);
  }

  return result;
}

/** The first, darkest shade used by a category. Its accounts sit under it. */
export const CATEGORY_COLOURS = (() => {
  const out = {};
  for (const name of CATEGORIES) {
    if (name === 'Debt') { out[name] = LIABILITY_COLOUR; continue; }
    const slot = CATEGORY_SLOT_START[name] || 0;
    out[name] = PHTHALO_SCALE[Math.min(slot, PHTHALO_SCALE.length - 1)].hex;
  }
  return out;
})();

/** Resolve the fixed colour for an account. Debt always gets the red. */
export function colourForAccount(account) {
  if (!account) return PHTHALO_SCALE[5].hex;
  if (account.type === 'liability') return LIABILITY_COLOUR;
  const index = Number.isInteger(account.colourIndex) ? account.colourIndex : 5;
  const safe = ((index % PHTHALO_SCALE.length) + PHTHALO_SCALE.length) % PHTHALO_SCALE.length;
  return PHTHALO_SCALE[safe].hex;
}

/** Black or white, whichever is legible on the given fill. */
export function readableTextOn(hex) {
  return contrastRatio(hex, '#FFFFFF') >= contrastRatio(hex, SUPPORTING_COLOURS.ink)
    ? '#FFFFFF'
    : SUPPORTING_COLOURS.ink;
}

/**
 * Report where two colours that sit side by side fall below the agreed
 * 15 point lightness step. Used by the tests and by the palette report so
 * the limits of a single hue palette are measured rather than assumed.
 */
export const MIN_LIGHTNESS_STEP = 15;

export function separationReport(hexes) {
  const pairs = [];
  for (let i = 1; i < hexes.length; i += 1) {
    const gap = Math.abs(lightnessOf(hexes[i]) - lightnessOf(hexes[i - 1]));
    pairs.push({
      index: i,
      gap,
      contrast: contrastRatio(hexes[i], hexes[i - 1]),
      meetsStep: gap >= MIN_LIGHTNESS_STEP
    });
  }
  return {
    pairs,
    minimumAdjacentGap: pairs.length ? Math.min(...pairs.map((p) => p.gap)) : Infinity,
    minimumPairwiseGap: minimumLightnessGap(hexes),
    allMeetStep: pairs.every((p) => p.meetsStep)
  };
}

/* ------------------------------------------------------------------ */
/* Date utilities                                                      */
/*                                                                     */
/* Everything is a YYYY-MM-DD string. UTC is used internally because   */
/* it has no daylight saving, which is where the classic off by one    */
/* day bug comes from.                                                 */
/* ------------------------------------------------------------------ */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isValidISODate(value) {
  if (typeof value !== 'string') return false;
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;
  if (year < 1900 || year > 2999) return false;
  return day <= daysInMonth(year, month);
}

export function parseISODate(value) {
  if (!isValidISODate(value)) throw new Error(`Not a valid date: ${value}`);
  const m = ISO_DATE.exec(value);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

export function toISODate(year, month, day) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

function utcMillis(iso) {
  const { year, month, day } = parseISODate(iso);
  return Date.UTC(year, month - 1, day);
}

/** Whole days from `a` to `b`. Negative when b is before a. */
export function daysBetween(a, b) {
  return Math.round((utcMillis(b) - utcMillis(a)) / 86400000);
}

export function addDays(iso, count) {
  const d = new Date(utcMillis(iso) + count * 86400000);
  return toISODate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

export function addMonths(iso, count) {
  const { year, month, day } = parseISODate(iso);
  const total = (year * 12) + (month - 1) + count;
  const newYear = Math.floor(total / 12);
  const newMonth = (total % 12) + 1;
  const newDay = Math.min(day, daysInMonth(newYear, newMonth));
  return toISODate(newYear, newMonth, newDay);
}

export function compareDates(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function clampDate(iso, min, max) {
  if (min && iso < min) return min;
  if (max && iso > max) return max;
  return iso;
}

export function monthKey(iso) {
  return iso.slice(0, 7);
}

export function startOfMonth(iso) {
  return `${monthKey(iso)}-01`;
}

/** Convert a Date to a local YYYY-MM-DD string. Used only at the edges. */
export function dateToISO(date) {
  return toISODate(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

/**
 * Calendar aware gap between two dates, broken into years, months and days.
 * Handles month boundaries and leap days correctly.
 */
export function timeRemaining(fromISO, toISO) {
  const signedDays = daysBetween(fromISO, toISO);
  const past = signedDays < 0;
  const start = past ? toISO : fromISO;
  const end = past ? fromISO : toISO;

  // Count whole calendar months first, then the leftover days. Doing it
  // this way follows the same end of month clamping as addMonths, so
  // 31 January to 1 March reads as one month and one day rather than
  // borrowing its way to a negative number of days.
  const totalDays = Math.abs(signedDays);
  let months = Math.max(0, Math.floor(totalDays / 31) - 1);
  while (months < 1200 && addMonths(start, months + 1) <= end) months += 1;
  const anchorDate = addMonths(start, months);
  const days = daysBetween(anchorDate, end);

  return {
    years: Math.floor(months / 12),
    months: months % 12,
    days,
    totalDays,
    past,
    signedDays
  };
}

export function describeTimeRemaining(tr) {
  if (!tr) return '';
  const parts = [];
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (tr.years) parts.push(plural(tr.years, 'year'));
  if (tr.months) parts.push(plural(tr.months, 'month'));
  if (tr.days || parts.length === 0) parts.push(plural(tr.days, 'day'));
  let text;
  if (parts.length === 1) text = parts[0];
  else text = `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return tr.past ? `${text} ago` : text;
}

/* ------------------------------------------------------------------ */
/* Money utilities                                                     */
/* ------------------------------------------------------------------ */

function groupThousands(digits) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Full precision, for example -1234567 becomes "-£12,345.67". */
export function formatMoney(pence, options = {}) {
  const { showPence = true, showSign = false } = options;
  const value = Number.isFinite(pence) ? Math.round(pence) : 0;
  const negative = value < 0;
  const abs = Math.abs(value);
  const pounds = Math.floor(abs / 100);
  const remainder = abs % 100;
  const body = showPence
    ? `${groupThousands(String(pounds))}.${String(remainder).padStart(2, '0')}`
    : groupThousands(String(Math.round(abs / 100)));
  const sign = negative ? '-' : showSign ? '+' : '';
  return `${sign}£${body}`;
}

/**
 * Abbreviated form. Only abbreviates above ten thousand pounds, as agreed,
 * so smaller everyday figures stay exact.
 */
export function formatMoneyCompact(pence) {
  const value = Number.isFinite(pence) ? Math.round(pence) : 0;
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs < 1000000) return formatMoney(value); // below ten thousand pounds
  const pounds = abs / 100;
  const trim = (s) => s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  if (pounds >= 1000000) return `${sign}£${trim((pounds / 1000000).toFixed(2))}m`;
  return `${sign}£${trim((pounds / 1000).toFixed(1))}k`;
}

export function formatPercent(fraction, decimals = 0) {
  if (!Number.isFinite(fraction)) return '0%';
  return `${(fraction * 100).toFixed(decimals)}%`;
}

/**
 * Parse user input into pence. Returns { ok, pence, error }. Rejects text,
 * blank input and anything with more than two decimal places.
 */
export function parseMoneyToPence(input, options = {}) {
  const { allowNegative = false, allowZero = false } = options;
  if (input === null || input === undefined) return { ok: false, error: 'Enter an amount' };
  const raw = String(input).trim().replace(/[£,\s]/g, '');
  if (raw === '') return { ok: false, error: 'Enter an amount' };
  if (!/^-?\d*(\.\d{1,2})?$/.test(raw) || raw === '-' || raw === '.') {
    return { ok: false, error: 'Use numbers only, with at most two decimal places' };
  }
  const negative = raw.startsWith('-');
  const [whole, frac = ''] = raw.replace('-', '').split('.');
  if (whole.length > 12) return { ok: false, error: 'That amount is too large' };
  const pence = (Number(whole || '0') * 100) + Number(frac.padEnd(2, '0'));
  const signed = negative ? -pence : pence;
  if (!allowNegative && signed < 0) return { ok: false, error: 'Amount cannot be negative' };
  if (!allowZero && signed === 0) return { ok: false, error: 'Amount must be more than zero' };
  return { ok: true, pence: signed };
}

/** Parse a quantity into integer units scaled by 1e8. */
export function parseUnitsToE8(input, options = {}) {
  const { allowZero = false } = options;
  if (input === null || input === undefined) return { ok: false, error: 'Enter a quantity' };
  const raw = String(input).trim().replace(/[,\s]/g, '');
  if (raw === '') return { ok: false, error: 'Enter a quantity' };
  if (!/^-?\d*(\.\d{1,8})?$/.test(raw) || raw === '-' || raw === '.') {
    return { ok: false, error: 'Use numbers only, with at most eight decimal places' };
  }
  const negative = raw.startsWith('-');
  const [whole, frac = ''] = raw.replace('-', '').split('.');
  if (whole.length > 10) return { ok: false, error: 'That quantity is too large' };
  const unitsE8 = (Number(whole || '0') * UNIT_SCALE) + Number(frac.padEnd(8, '0'));
  const signed = negative ? -unitsE8 : unitsE8;
  if (signed < 0) return { ok: false, error: 'Quantity cannot be negative' };
  if (!allowZero && signed === 0) return { ok: false, error: 'Quantity must be more than zero' };
  return { ok: true, unitsE8: signed };
}

export function formatUnits(unitsE8, maxDecimals = 8) {
  const value = Number.isFinite(unitsE8) ? unitsE8 : 0;
  const negative = value < 0;
  const abs = Math.abs(Math.round(value));
  const whole = Math.floor(abs / UNIT_SCALE);
  const frac = String(abs % UNIT_SCALE).padStart(8, '0').slice(0, maxDecimals).replace(/0+$/, '');
  const text = frac ? `${groupThousands(String(whole))}.${frac}` : groupThousands(String(whole));
  return negative ? `-${text}` : text;
}

/**
 * Value of a quantity holding, in whole pence. Uses BigInt for the
 * multiplication so large holdings cannot drift by a penny.
 */
export function quantityValuePence(unitsE8, unitPricePence) {
  if (!Number.isFinite(unitsE8) || !Number.isFinite(unitPricePence)) return 0;
  const u = Math.round(unitsE8);
  const p = Math.round(unitPricePence);
  if (u === 0 || p === 0) return 0;
  const negative = (u < 0) !== (p < 0);
  const product = BigInt(Math.abs(u)) * BigInt(Math.abs(p));
  const scale = BigInt(UNIT_SCALE);
  const rounded = (product + (scale / 2n)) / scale; // round half up
  const value = Number(rounded);
  return negative ? -value : value;
}

/** How many units a given amount of money buys at a given price. */
export function unitsForPence(pence, unitPricePence) {
  if (!Number.isFinite(pence) || !Number.isFinite(unitPricePence) || unitPricePence <= 0) return 0;
  const product = BigInt(Math.abs(Math.round(pence))) * BigInt(UNIT_SCALE);
  const price = BigInt(Math.round(unitPricePence));
  const rounded = (product + (price / 2n)) / price;
  const value = Number(rounded);
  return pence < 0 ? -value : value;
}

/* ------------------------------------------------------------------ */
/* State shape helpers                                                 */
/* ------------------------------------------------------------------ */

export function isAssetAccount(account) {
  return account.type === 'quantity' || account.type === 'balance';
}

export function activeAccounts(state) {
  return (state.accounts || []).filter((a) => !a.archived).slice()
    .sort((a, b) => (a.order - b.order) || compareStrings(a.id, b.id));
}

function compareStrings(a, b) {
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/** Transactions in the order they affect the ledger: date, then insertion. */
export function sortedTransactions(state) {
  return (state.transactions || []).slice().sort((a, b) => {
    if (a.date !== b.date) return compareDates(a.date, b.date);
    const ca = a.createdAt || '';
    const cb = b.createdAt || '';
    if (ca !== cb) return compareStrings(ca, cb);
    return compareStrings(a.id, b.id);
  });
}

export function transactionsForAccount(state, accountId) {
  return sortedTransactions(state).filter((t) => t.accountId === accountId);
}

/** Signed effect of a transaction on the account balance. */
export function signedPence(tx) {
  const amount = Math.abs(Math.round(tx.amountPence || 0));
  return tx.direction === 'out' ? -amount : amount;
}

export function signedUnitsE8(tx) {
  const units = Math.abs(Math.round(tx.unitsE8 || 0));
  return tx.direction === 'out' ? -units : units;
}

/* ------------------------------------------------------------------ */
/* Prices                                                              */
/* ------------------------------------------------------------------ */

/**
 * Build the price history for a quantity account from the prices recorded
 * on its own transactions plus the current stored price. Historic values
 * are then honest about what the holding was worth at the time.
 */
export function buildPriceTimeline(account, transactions, todayISO) {
  const points = [];
  for (const tx of transactions) {
    if (tx.accountId !== account.id) continue;
    if (Number.isFinite(tx.unitPricePence) && tx.unitPricePence > 0) {
      points.push({ date: tx.date, pricePence: Math.round(tx.unitPricePence) });
    }
  }
  const current = Math.round(account.unitPricePence || 0);
  if (current > 0) {
    points.push({ date: account.priceUpdatedAt || todayISO, pricePence: current });
  }
  points.sort((a, b) => compareDates(a.date, b.date));
  return points;
}

export function priceAt(timeline, dateISO) {
  if (!timeline.length) return 0;
  let value = timeline[0].pricePence; // before the first known price, use the first
  for (const point of timeline) {
    if (point.date <= dateISO) value = point.pricePence;
    else break;
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* Balances and totals                                                 */
/* ------------------------------------------------------------------ */

/**
 * Balance of every account on a given date.
 * Returns a Map of accountId to { unitsE8, valuePence, pricePence }.
 * `valuePence` is always positive for a liability; the sign is applied by
 * the net worth calculation.
 */
export function balancesAt(state, dateISO) {
  const accounts = activeAccounts(state);
  const txs = sortedTransactions(state).filter((t) => t.date <= dateISO);
  const byId = new Map();
  const timelines = new Map();

  for (const account of accounts) {
    byId.set(account.id, { unitsE8: 0, rawPence: 0, valuePence: 0, pricePence: 0 });
    if (account.type === 'quantity') {
      timelines.set(account.id, buildPriceTimeline(account, state.transactions || [], dateISO));
    }
  }

  for (const tx of txs) {
    const entry = byId.get(tx.accountId);
    if (!entry) continue;
    entry.rawPence += signedPence(tx);
    entry.unitsE8 += signedUnitsE8(tx);
  }

  for (const account of accounts) {
    const entry = byId.get(account.id);
    if (account.type === 'quantity') {
      const price = priceAt(timelines.get(account.id) || [], dateISO);
      entry.pricePence = price;
      entry.valuePence = quantityValuePence(entry.unitsE8, price);
    } else {
      entry.valuePence = entry.rawPence;
    }
  }

  return byId;
}

/** Net worth on a date: assets minus liabilities, in pence. */
export function netWorthAt(state, dateISO) {
  const balances = balancesAt(state, dateISO);
  let assets = 0;
  let liabilities = 0;
  for (const account of activeAccounts(state)) {
    const entry = balances.get(account.id);
    if (!entry) continue;
    if (account.type === 'liability') liabilities += entry.valuePence;
    else assets += entry.valuePence;
  }
  return { assetsPence: assets, liabilitiesPence: liabilities, netWorthPence: assets - liabilities };
}

/** Totals by category on a date. Debt is reported as a positive figure. */
export function categoryTotals(state, dateISO) {
  const balances = balancesAt(state, dateISO);
  const totals = {};
  for (const name of CATEGORIES) totals[name] = 0;
  for (const account of activeAccounts(state)) {
    const entry = balances.get(account.id);
    if (!entry) continue;
    const key = CATEGORIES.includes(account.category) ? account.category : 'Cash';
    totals[key] += entry.valuePence;
  }
  return totals;
}

/** Percentage split across asset categories only. Debt is excluded. */
export function allocationByCategory(state, dateISO) {
  const totals = categoryTotals(state, dateISO);
  const assetCategories = CATEGORIES.filter((c) => c !== 'Debt');
  const positive = assetCategories.map((name) => ({ name, valuePence: Math.max(0, totals[name] || 0) }));
  const total = positive.reduce((sum, row) => sum + row.valuePence, 0);
  return positive.map((row) => ({
    ...row,
    fraction: total > 0 ? row.valuePence / total : 0,
    colour: CATEGORY_COLOURS[row.name]
  }));
}

/** Accounts with their current value, sorted largest first. Debt last. */
export function positionSeries(state, dateISO) {
  const balances = balancesAt(state, dateISO);
  const rows = activeAccounts(state).map((account) => {
    const entry = balances.get(account.id) || { valuePence: 0, unitsE8: 0, pricePence: 0 };
    const isLiability = account.type === 'liability';
    return {
      id: account.id,
      name: account.name,
      category: account.category,
      type: account.type,
      unitsE8: entry.unitsE8,
      pricePence: entry.pricePence,
      valuePence: isLiability ? -entry.valuePence : entry.valuePence,
      magnitudePence: Math.abs(entry.valuePence),
      colour: colourForAccount(account)
    };
  });
  const assets = rows.filter((r) => r.type !== 'liability')
    .sort((a, b) => b.valuePence - a.valuePence || compareStrings(a.name, b.name));
  const liabilities = rows.filter((r) => r.type === 'liability')
    .sort((a, b) => a.valuePence - b.valuePence || compareStrings(a.name, b.name));
  return [...assets, ...liabilities];
}

/* ------------------------------------------------------------------ */
/* Daily net worth series                                              */
/*                                                                     */
/* Built by walking the whole transaction history in date order, never  */
/* by appending a snapshot, so editing an old entry rewrites history.   */
/* ------------------------------------------------------------------ */

export const MAX_SERIES_DAYS = 366 * 25;

export function earliestTransactionDate(state) {
  const txs = sortedTransactions(state);
  return txs.length ? txs[0].date : null;
}

export function buildDailySeries(state, options = {}) {
  const today = options.today || dateToISO(new Date());
  const accounts = activeAccounts(state);
  const allTxs = sortedTransactions(state);

  const earliest = allTxs.length ? allTxs[0].date : today;
  let from = options.fromDate || earliest;
  let to = options.toDate || today;
  if (to < from) to = from;

  let span = daysBetween(from, to);
  if (span > MAX_SERIES_DAYS) {
    from = addDays(to, -MAX_SERIES_DAYS);
    span = MAX_SERIES_DAYS;
  }

  // Running balances, seeded with everything before the window starts.
  const running = new Map();
  const timelines = new Map();
  for (const account of accounts) {
    running.set(account.id, { unitsE8: 0, rawPence: 0 });
    if (account.type === 'quantity') {
      timelines.set(account.id, buildPriceTimeline(account, allTxs, today));
    }
  }

  let cursor = 0;
  while (cursor < allTxs.length && allTxs[cursor].date < from) {
    const tx = allTxs[cursor];
    const entry = running.get(tx.accountId);
    if (entry) {
      entry.rawPence += signedPence(tx);
      entry.unitsE8 += signedUnitsE8(tx);
    }
    cursor += 1;
  }

  const series = [];
  let date = from;
  for (let i = 0; i <= span; i += 1) {
    while (cursor < allTxs.length && allTxs[cursor].date <= date) {
      const tx = allTxs[cursor];
      const entry = running.get(tx.accountId);
      if (entry) {
        entry.rawPence += signedPence(tx);
        entry.unitsE8 += signedUnitsE8(tx);
      }
      cursor += 1;
    }

    let assets = 0;
    let liabilities = 0;
    for (const account of accounts) {
      const entry = running.get(account.id);
      let value;
      if (account.type === 'quantity') {
        value = quantityValuePence(entry.unitsE8, priceAt(timelines.get(account.id) || [], date));
      } else {
        value = entry.rawPence;
      }
      if (account.type === 'liability') liabilities += value;
      else assets += value;
    }

    series.push({
      date,
      assetsPence: assets,
      liabilitiesPence: liabilities,
      netWorthPence: assets - liabilities
    });

    if (i < span) date = addDays(date, 1);
  }

  return series;
}

export const RANGE_PRESETS = {
  '1m': { label: '1 month', months: 1 },
  '6m': { label: '6 months', months: 6 },
  '1y': { label: '1 year', months: 12 },
  all: { label: 'All time', months: null }
};

export function rangeStartDate(rangeKey, state, todayISO) {
  const preset = RANGE_PRESETS[rangeKey] || RANGE_PRESETS.all;
  const earliest = earliestTransactionDate(state) || todayISO;
  if (preset.months === null) return earliest;
  const start = addMonths(todayISO, -preset.months);
  return start < earliest ? earliest : start;
}

/** Money in and money out per calendar month, for the last N months. */
export function contributionsByMonth(state, options = {}) {
  const today = options.today || dateToISO(new Date());
  const months = options.months || 12;
  const accountFilter = options.accountId || null;

  const keys = [];
  for (let i = months - 1; i >= 0; i -= 1) keys.push(monthKey(addMonths(startOfMonth(today), -i)));

  const buckets = new Map(keys.map((k) => [k, { month: k, inPence: 0, outPence: 0 }]));
  const active = new Set(activeAccounts(state).map((a) => a.id));

  for (const tx of sortedTransactions(state)) {
    if (!active.has(tx.accountId)) continue;
    if (accountFilter && tx.accountId !== accountFilter) continue;
    const bucket = buckets.get(monthKey(tx.date));
    if (!bucket) continue;
    const amount = Math.abs(Math.round(tx.amountPence || 0));
    if (tx.direction === 'out') bucket.outPence += amount;
    else bucket.inPence += amount;
  }

  return keys.map((k) => {
    const b = buckets.get(k);
    return { ...b, netPence: b.inPence - b.outPence };
  });
}

/* ------------------------------------------------------------------ */
/* Goals                                                               */
/* ------------------------------------------------------------------ */

/** Required contributions to reach `remainingPence` within `daysRemaining`. */
export function requiredRates(remainingPence, daysRemaining) {
  const remaining = Math.max(0, Math.round(remainingPence || 0));
  if (remaining === 0) {
    return { perDayPence: 0, perWeekPence: 0, perMonthPence: 0, achievable: true };
  }
  if (!Number.isFinite(daysRemaining) || daysRemaining <= 0) {
    return { perDayPence: null, perWeekPence: null, perMonthPence: null, achievable: false };
  }
  return {
    perDayPence: Math.ceil(remaining / daysRemaining),
    perWeekPence: Math.ceil((remaining * 7) / daysRemaining),
    perMonthPence: Math.ceil((remaining * DAYS_PER_MONTH) / daysRemaining),
    achievable: true
  };
}

/**
 * Full goal picture for one account.
 *
 * For an asset the goal is to grow the balance to `targetPence`.
 * For a liability the goal is to reduce the balance to `targetPence`,
 * which is normally zero.
 */
export function goalProgress(account, currentPence, todayISO) {
  const goal = account && account.goal;
  if (!goal) return null;

  const isDebt = account.type === 'liability';
  const target = Math.round(goal.targetPence || 0);
  const current = Math.round(currentPence || 0);
  const startPence = Math.round(
    Number.isFinite(goal.startPence) ? goal.startPence : (isDebt ? current : 0)
  );
  const startDate = isValidISODate(goal.startDate) ? goal.startDate : todayISO;
  const targetDate = isValidISODate(goal.targetDate) ? goal.targetDate : null;

  const totalDistance = isDebt ? (startPence - target) : (target - startPence);
  const travelled = isDebt ? (startPence - current) : (current - startPence);
  const remaining = isDebt ? Math.max(0, current - target) : Math.max(0, target - current);

  // Percentage reached. A zero sized goal is already complete by definition.
  let fraction;
  if (totalDistance <= 0) fraction = 1;
  else fraction = travelled / totalDistance;
  if (!Number.isFinite(fraction)) fraction = 0;
  const rawPercent = fraction * 100;
  const percent = Math.max(0, Math.min(100, rawPercent));
  const exceeded = rawPercent > 100.0000001;
  const reached = remaining === 0;

  const tr = targetDate ? timeRemaining(todayISO, targetDate) : null;
  const daysRemaining = targetDate ? daysBetween(todayISO, targetDate) : null;
  const overdue = Boolean(targetDate) && daysRemaining < 0 && !reached;

  const rates = requiredRates(remaining, daysRemaining === null ? Infinity : daysRemaining);

  // Straight line pace from the goal start to the target date.
  let pace = null;
  if (targetDate) {
    const totalDays = daysBetween(startDate, targetDate);
    const elapsedDays = daysBetween(startDate, todayISO);
    let elapsedFraction;
    if (totalDays <= 0) elapsedFraction = 1;
    else elapsedFraction = Math.max(0, Math.min(1, elapsedDays / totalDays));
    const expectedTravelled = totalDistance * elapsedFraction;
    const expectedPence = isDebt
      ? Math.round(startPence - expectedTravelled)
      : Math.round(startPence + expectedTravelled);
    const differencePence = isDebt ? (expectedPence - current) : (current - expectedPence);
    // Being a few pounds either side of a straight line is not news. The
    // tolerance scales with the size of the goal so the label does not
    // flicker between ahead and behind on every small entry.
    const tolerance = Math.max(100, Math.round(Math.abs(totalDistance) * 0.005));
    let status;
    if (reached) status = 'reached';
    else if (Math.abs(differencePence) <= tolerance) status = 'on track';
    else status = differencePence > 0 ? 'ahead' : 'behind';
    pace = {
      expectedPence,
      differencePence,
      tolerancePence: tolerance,
      status,
      elapsedFraction,
      totalDays,
      elapsedDays
    };
  }

  let status;
  if (reached) status = exceeded ? 'exceeded' : 'reached';
  else if (overdue) status = 'overdue';
  else status = pace ? pace.status : 'in progress';

  return {
    accountId: account.id,
    isDebt,
    targetPence: target,
    currentPence: current,
    startPence,
    startDate,
    targetDate,
    remainingPence: remaining,
    fraction,
    percent,
    rawPercent,
    exceeded,
    reached,
    overdue,
    zeroTarget: totalDistance <= 0,
    daysRemaining,
    timeRemaining: tr,
    rates,
    pace,
    status
  };
}

/* ------------------------------------------------------------------ */
/* Debt payoff projection                                              */
/* ------------------------------------------------------------------ */

/**
 * Average monthly repayment over the last `windowMonths` calendar months.
 * Only payments count, not new borrowing.
 */
export function averageMonthlyRepayment(state, accountId, options = {}) {
  const today = options.today || dateToISO(new Date());
  const windowMonths = options.windowMonths || 6;
  const start = startOfMonth(addMonths(today, -(windowMonths - 1)));
  let total = 0;
  for (const tx of sortedTransactions(state)) {
    if (tx.accountId !== accountId) continue;
    if (tx.date < start || tx.date > today) continue;
    if (tx.direction === 'out') total += Math.abs(Math.round(tx.amountPence || 0));
  }
  return Math.round(total / windowMonths);
}

/**
 * Months until a debt is cleared at a given monthly payment.
 * Returns { months, payoffDate, reason } where months is null when the
 * debt will never clear at that rate.
 */
export function projectPayoff(balancePence, monthlyPaymentPence, annualRatePct, todayISO) {
  const balance = Math.max(0, Math.round(balancePence || 0));
  const payment = Math.max(0, Math.round(monthlyPaymentPence || 0));
  const rate = Number.isFinite(annualRatePct) ? Math.max(0, annualRatePct) : 0;

  if (balance === 0) {
    return { months: 0, payoffDate: todayISO || null, totalInterestPence: 0, reason: 'cleared' };
  }
  if (payment <= 0) {
    return { months: null, payoffDate: null, totalInterestPence: null, reason: 'no payments recorded' };
  }

  const monthlyRate = rate / 100 / 12;
  if (monthlyRate === 0) {
    const months = Math.ceil(balance / payment);
    return {
      months,
      payoffDate: todayISO ? addMonths(todayISO, months) : null,
      totalInterestPence: 0,
      reason: 'no interest'
    };
  }

  const interestOnly = balance * monthlyRate;
  if (payment <= interestOnly) {
    return {
      months: null,
      payoffDate: null,
      totalInterestPence: null,
      reason: 'payments do not cover the interest'
    };
  }

  const months = Math.ceil(
    -Math.log(1 - ((balance * monthlyRate) / payment)) / Math.log(1 + monthlyRate)
  );
  const totalPaid = months * payment;
  return {
    months,
    payoffDate: todayISO ? addMonths(todayISO, months) : null,
    totalInterestPence: Math.max(0, Math.round(totalPaid - balance)),
    reason: 'projected'
  };
}

/* ------------------------------------------------------------------ */
/* Withdrawal checks                                                   */
/* ------------------------------------------------------------------ */

/**
 * Warn before a withdrawal that would push an asset account negative.
 * Returns { ok, warning } rather than blocking, because a correction
 * entry sometimes legitimately needs to do this.
 */
export function checkWithdrawal(account, currentPence, amountPence) {
  if (!account || account.type === 'liability') return { ok: true, warning: null };
  const after = Math.round(currentPence) - Math.round(amountPence);
  if (after >= 0) return { ok: true, warning: null };
  return {
    ok: false,
    warning: `That takes ${account.name} to ${formatMoney(after)}, which is below zero. `
      + `The balance today is ${formatMoney(currentPence)}.`
  };
}

/* ------------------------------------------------------------------ */
/* CSV                                                                 */
/* ------------------------------------------------------------------ */

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export const CSV_HEADERS = [
  'Date',
  'Account',
  'Category',
  'Type',
  'Direction',
  'Amount (GBP)',
  'Units',
  'Unit price (GBP)',
  'Note'
];

export function transactionsToCsv(state) {
  const accounts = new Map((state.accounts || []).map((a) => [a.id, a]));
  const lines = [CSV_HEADERS.map(csvCell).join(',')];
  for (const tx of sortedTransactions(state)) {
    const account = accounts.get(tx.accountId);
    const amount = (Math.abs(Math.round(tx.amountPence || 0)) / 100).toFixed(2);
    const signedAmount = tx.direction === 'out' ? `-${amount}` : amount;
    lines.push([
      tx.date,
      account ? account.name : tx.accountId,
      account ? account.category : '',
      account ? account.type : '',
      tx.direction === 'out' ? 'Out' : 'In',
      signedAmount,
      tx.unitsE8 ? formatUnits(tx.unitsE8) : '',
      Number.isFinite(tx.unitPricePence) && tx.unitPricePence
        ? (tx.unitPricePence / 100).toFixed(2)
        : '',
      tx.note || ''
    ].map(csvCell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

/* ------------------------------------------------------------------ */
/* Import validation                                                   */
/* ------------------------------------------------------------------ */

/**
 * Check a parsed object really is a Phthalo Finance backup before any of
 * it is loaded. Returns { ok, errors }. Never half loads.
 */
export function validateImport(candidate) {
  const errors = [];
  const fail = (message) => { errors.push(message); };

  if (candidate === null || candidate === undefined) {
    return { ok: false, errors: ['The file is empty.'] };
  }
  if (typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, errors: ['The file does not contain a Phthalo Finance backup.'] };
  }
  if (!('accounts' in candidate) && !('transactions' in candidate)) {
    return { ok: false, errors: ['The file has no accounts or transactions in it.'] };
  }
  if (!Array.isArray(candidate.accounts)) fail('"accounts" should be a list.');
  if (!Array.isArray(candidate.transactions)) fail('"transactions" should be a list.');
  if ('schemaVersion' in candidate && !Number.isInteger(candidate.schemaVersion)) {
    fail('"schemaVersion" should be a whole number.');
  }
  if (Number.isInteger(candidate.schemaVersion) && candidate.schemaVersion > SCHEMA_VERSION) {
    fail(`This backup was made by a newer version of the app (schema ${candidate.schemaVersion}).`);
  }
  if (errors.length) return { ok: false, errors };

  const ids = new Set();
  candidate.accounts.forEach((account, i) => {
    const where = `Account ${i + 1}`;
    if (!account || typeof account !== 'object') { fail(`${where} is not an object.`); return; }
    if (typeof account.id !== 'string' || !account.id) fail(`${where} has no id.`);
    else if (ids.has(account.id)) fail(`${where} repeats the id "${account.id}".`);
    else ids.add(account.id);
    if (typeof account.name !== 'string' || !account.name) fail(`${where} has no name.`);
    if (!ACCOUNT_TYPES.includes(account.type)) fail(`${where} has an unknown type "${account.type}".`);
    if (account.type === 'quantity' && account.unitPricePence !== undefined
      && !Number.isFinite(account.unitPricePence)) {
      fail(`${where} has a unit price that is not a number.`);
    }
    if (account.goal) {
      if (typeof account.goal !== 'object') fail(`${where} has a goal that is not an object.`);
      else {
        if (!Number.isFinite(account.goal.targetPence)) fail(`${where} has a goal target that is not a number.`);
        if (account.goal.targetDate && !isValidISODate(account.goal.targetDate)) {
          fail(`${where} has an impossible goal date "${account.goal.targetDate}".`);
        }
      }
    }
  });

  candidate.transactions.forEach((tx, i) => {
    const where = `Transaction ${i + 1}`;
    if (!tx || typeof tx !== 'object') { fail(`${where} is not an object.`); return; }
    if (typeof tx.accountId !== 'string' || !ids.has(tx.accountId)) {
      fail(`${where} points at an account that is not in the file.`);
    }
    if (!isValidISODate(tx.date)) fail(`${where} has an impossible date "${tx.date}".`);
    if (!Number.isFinite(tx.amountPence)) fail(`${where} has an amount that is not a number.`);
    if (tx.direction !== 'in' && tx.direction !== 'out') {
      fail(`${where} has an unknown direction "${tx.direction}".`);
    }
  });

  if (errors.length > 8) {
    const shown = errors.slice(0, 8);
    shown.push(`and ${errors.length - 8} more problems.`);
    return { ok: false, errors: shown };
  }
  return { ok: errors.length === 0, errors };
}

/* ------------------------------------------------------------------ */
/* Schema and migration                                                */
/* ------------------------------------------------------------------ */

export const DEFAULT_VISUALS = [
  { id: 'netWorth', enabled: true },
  { id: 'position', enabled: true },
  { id: 'allocation', enabled: true },
  { id: 'goals', enabled: true },
  { id: 'contributions', enabled: true },
  { id: 'monthlyNet', enabled: false },
  { id: 'holdings', enabled: false },
  { id: 'categoryTotals', enabled: false }
];

export const VISUAL_LIBRARY = {
  netWorth: { name: 'Net worth over time', blurb: 'The line chart of everything you own minus what you owe.' },
  position: { name: 'Combined position', blurb: 'Every account as a bar, largest first, with debt below the line.' },
  allocation: { name: 'Allocation by category', blurb: 'One stacked bar showing the split across your categories.' },
  goals: { name: 'Goal progress', blurb: 'A progress bar per goal with a marker for where you should be today.' },
  contributions: { name: 'Contributions', blurb: 'Money in against money out, month by month.' },
  monthlyNet: { name: 'Net saved each month', blurb: 'What is left after money out, month by month.' },
  holdings: { name: 'Holdings and prices', blurb: 'Units held and the unit price behind each quantity account.' },
  categoryTotals: { name: 'Category totals', blurb: 'A bar per category rather than per account.' }
};

export function emptyState(todayISO) {
  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt: todayISO,
    updatedAt: todayISO,
    lastExportAt: null,
    settings: {
      theme: 'system',
      netWorthRange: '1y',
      notices: { iosStorage: false, backupReminder: null }
    },
    accounts: [],
    transactions: [],
    visuals: DEFAULT_VISUALS.map((v, i) => ({ ...v, order: i }))
  };
}

/** Fill in anything a hand edited or older file is missing. */
export function normaliseState(state, todayISO) {
  const base = emptyState(todayISO);
  const out = {
    ...base,
    ...state,
    settings: { ...base.settings, ...(state.settings || {}) },
    accounts: Array.isArray(state.accounts) ? state.accounts : [],
    transactions: Array.isArray(state.transactions) ? state.transactions : []
  };
  out.settings.notices = { ...base.settings.notices, ...((state.settings || {}).notices || {}) };
  out.schemaVersion = SCHEMA_VERSION;

  // Visuals: keep the saved order and enabled flags, add anything new.
  const saved = Array.isArray(state.visuals) ? state.visuals : [];
  const known = new Map(saved
    .filter((v) => v && typeof v.id === 'string' && VISUAL_LIBRARY[v.id])
    .map((v, i) => [v.id, { id: v.id, enabled: v.enabled !== false, order: Number.isFinite(v.order) ? v.order : i }]));
  DEFAULT_VISUALS.forEach((v, i) => {
    if (!known.has(v.id)) known.set(v.id, { ...v, order: 1000 + i });
  });
  out.visuals = Array.from(known.values())
    .sort((a, b) => a.order - b.order)
    .map((v, i) => ({ ...v, order: i }));

  out.accounts = out.accounts.map((account, i) => canonicalAccount(account, i));
  out.transactions = out.transactions.map((tx) => canonicalTransaction(tx));

  return out;
}

/**
 * Fields are written in a fixed order so that exporting the same data
 * twice produces byte identical files. Without this, an account created
 * by the interface and the same account read back from a backup differ
 * only in key order, which makes two backups impossible to compare.
 * Anything unrecognised is carried through rather than dropped.
 */
const ACCOUNT_FIELD_ORDER = [
  'id', 'name', 'type', 'category', 'order', 'colourIndex', 'archived', 'note', 'goal',
  'unit', 'unitPricePence', 'priceUpdatedAt', 'priceSource', 'priceSymbol', 'priceKind',
  'interestRatePct'
];

const TRANSACTION_FIELD_ORDER = [
  'id', 'accountId', 'date', 'direction', 'amountPence', 'unitsE8', 'unitPricePence',
  'note', 'createdAt'
];

function withExtras(built, source, known) {
  for (const key of Object.keys(source)) {
    if (!known.includes(key)) built[key] = source[key];
  }
  return built;
}

export function canonicalAccount(account, index = 0) {
  const type = ACCOUNT_TYPES.includes(account.type) ? account.type : 'balance';
  const built = {
    id: account.id,
    name: account.name,
    type,
    category: account.category || (type === 'liability' ? 'Debt' : 'Cash'),
    order: Number.isFinite(account.order) ? account.order : index,
    colourIndex: Number.isInteger(account.colourIndex) ? account.colourIndex : index,
    archived: Boolean(account.archived),
    note: account.note || '',
    goal: account.goal || null
  };
  if (type === 'quantity') {
    built.unit = account.unit || 'units';
    built.unitPricePence = Math.round(account.unitPricePence || 0);
    built.priceUpdatedAt = account.priceUpdatedAt || null;
    built.priceSource = account.priceSource || 'manual';
    if (account.priceSymbol) built.priceSymbol = account.priceSymbol;
    if (account.priceKind) built.priceKind = account.priceKind;
  }
  if (type === 'liability' && account.interestRatePct !== undefined
    && account.interestRatePct !== null) {
    built.interestRatePct = account.interestRatePct;
  }
  return withExtras(built, account, ACCOUNT_FIELD_ORDER);
}

export function canonicalTransaction(tx) {
  const built = {
    id: tx.id,
    accountId: tx.accountId,
    date: tx.date,
    direction: tx.direction === 'out' ? 'out' : 'in',
    amountPence: Math.round(Math.abs(tx.amountPence || 0)),
    unitsE8: Math.round(Math.abs(tx.unitsE8 || 0)),
    unitPricePence: Number.isFinite(tx.unitPricePence) ? tx.unitPricePence : null,
    note: tx.note || '',
    createdAt: tx.createdAt || `${tx.date}T00:00:00.000Z`
  };
  return withExtras(built, tx, TRANSACTION_FIELD_ORDER);
}

/**
 * Upgrade an older saved object to the current schema.
 *
 * Version 0 is anything without a schemaVersion. That shape stored money
 * as floating point pounds on the account itself, which is exactly the
 * drift this app exists to avoid, so it is converted to integer pence.
 */
const MIGRATIONS = {
  0: function migrateZeroToOne(old, todayISO) {
    const accounts = (old.accounts || []).map((account, i) => {
      const type = account.type
        || (account.isDebt ? 'liability' : (account.units !== undefined ? 'quantity' : 'balance'));
      const migrated = {
        id: account.id || `acc_${i}`,
        name: account.name || `Account ${i + 1}`,
        type,
        category: account.category || (type === 'liability' ? 'Debt' : 'Cash'),
        order: Number.isFinite(account.order) ? account.order : i,
        colourIndex: i,
        archived: Boolean(account.archived),
        note: account.note || '',
        goal: null
      };
      if (type === 'quantity') {
        migrated.unit = account.unit || 'units';
        migrated.unitPricePence = Math.round((Number(account.unitPrice) || 0) * 100);
        migrated.priceUpdatedAt = account.priceUpdatedAt || null;
        migrated.priceSource = 'manual';
      }
      if (type === 'liability' && account.interestRate !== undefined) {
        migrated.interestRatePct = Number(account.interestRate) || 0;
      }
      if (account.goalTarget !== undefined || account.goalDate !== undefined) {
        migrated.goal = {
          targetPence: Math.round((Number(account.goalTarget) || 0) * 100),
          targetDate: isValidISODate(account.goalDate) ? account.goalDate : null,
          startDate: isValidISODate(account.goalStart) ? account.goalStart : todayISO,
          startPence: 0
        };
      }
      return migrated;
    });

    const transactions = (old.transactions || []).map((tx, i) => {
      const amount = Number(tx.amount);
      const direction = tx.direction || (amount < 0 ? 'out' : 'in');
      let date = tx.date;
      if (typeof date === 'number') date = new Date(date).toISOString().slice(0, 10);
      if (typeof date === 'string' && date.length > 10) date = date.slice(0, 10);
      return {
        id: tx.id || `tx_${i}`,
        accountId: tx.accountId || tx.account || '',
        date: isValidISODate(date) ? date : todayISO,
        direction,
        amountPence: Math.round(Math.abs(amount || 0) * 100),
        unitsE8: tx.units ? Math.round(Math.abs(Number(tx.units)) * UNIT_SCALE) : 0,
        unitPricePence: tx.unitPrice ? Math.round(Number(tx.unitPrice) * 100) : null,
        note: tx.note || '',
        createdAt: tx.createdAt || `${isValidISODate(date) ? date : todayISO}T00:00:00.000Z`
      };
    });

    return {
      schemaVersion: 1,
      createdAt: old.createdAt || todayISO,
      updatedAt: todayISO,
      lastExportAt: old.lastExportAt || null,
      settings: old.settings || {},
      accounts,
      transactions,
      visuals: Array.isArray(old.visuals) ? old.visuals : undefined
    };
  }
};

export function migrate(saved, todayISO) {
  if (!saved || typeof saved !== 'object') return { state: emptyState(todayISO), migratedFrom: null };
  let working = saved;
  let version = Number.isInteger(working.schemaVersion) ? working.schemaVersion : 0;
  const startedAt = version;
  let guard = 0;
  while (version < SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) break;
    working = step(working, todayISO);
    version = Number.isInteger(working.schemaVersion) ? working.schemaVersion : version + 1;
    guard += 1;
    if (guard > 20) break;
  }
  return {
    state: normaliseState(working, todayISO),
    migratedFrom: startedAt < SCHEMA_VERSION ? startedAt : null
  };
}

/* ------------------------------------------------------------------ */
/* Chart scale helpers                                                 */
/* ------------------------------------------------------------------ */

/** Round a range outwards to friendly tick values. */
export function niceScale(min, max, targetTicks = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, step: 1, ticks: [0, 1] };
  if (min === max) {
    const pad = Math.abs(min) > 0 ? Math.abs(min) * 0.1 : 1;
    min -= pad;
    max += pad;
  }
  const span = max - min;
  const rawStep = span / Math.max(1, targetTicks);
  const magnitude = Math.pow(10, Math.floor(Math.log10(Math.abs(rawStep) || 1)));
  const candidates = [1, 2, 2.5, 5, 10].map((m) => m * magnitude);
  const step = candidates.find((c) => c >= rawStep) || candidates[candidates.length - 1];
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = niceMin; v <= niceMax + step / 1000; v += step) ticks.push(Math.round(v));
  return { min: niceMin, max: niceMax, step, ticks };
}

/** Reduce a series to at most `maxPoints` evenly sampled points. */
export function sampleSeries(series, maxPoints) {
  if (series.length <= maxPoints) return series;
  const out = [];
  const stride = (series.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i += 1) out.push(series[Math.round(i * stride)]);
  out[out.length - 1] = series[series.length - 1];
  return out;
}

/** Change between the first and last point of a series. */
export function seriesChange(series) {
  if (!series || series.length === 0) return { absolutePence: 0, fraction: 0, hasBase: false };
  const first = series[0].netWorthPence;
  const last = series[series.length - 1].netWorthPence;
  const absolute = last - first;
  const hasBase = first !== 0;
  return {
    absolutePence: absolute,
    fraction: hasBase ? absolute / Math.abs(first) : 0,
    hasBase,
    firstPence: first,
    lastPence: last
  };
}

/* ------------------------------------------------------------------ */
/* Plain English chart titles                                          */
/*                                                                     */
/* Every chart states its finding rather than naming its mechanic.     */
/* ------------------------------------------------------------------ */

export function netWorthTitle(series, rangeKey) {
  const preset = RANGE_PRESETS[rangeKey] || RANGE_PRESETS.all;
  const period = preset.months === null ? 'since you started' : `over the last ${preset.label}`;
  if (!series || series.length < 2) return 'Net worth needs a few entries before it can show a trend';
  const change = seriesChange(series);
  if (change.absolutePence === 0) return `Net worth is unchanged ${period}`;
  const direction = change.absolutePence > 0 ? 'up' : 'down';
  const amount = formatMoneyCompact(Math.abs(change.absolutePence));
  if (!change.hasBase) return `Net worth ${direction} ${amount} ${period}`;
  const pct = Math.abs(change.fraction * 100);
  const pctText = pct >= 100 ? pct.toFixed(0) : pct.toFixed(1);
  return `Net worth ${direction} ${pctText} percent ${period}`;
}

export function positionTitle(rows) {
  const assets = rows.filter((r) => r.type !== 'liability' && r.valuePence > 0);
  if (!assets.length) return 'No account holds a balance yet';
  const top = assets[0];
  const total = assets.reduce((sum, r) => sum + r.valuePence, 0);
  const share = total > 0 ? Math.round((top.valuePence / total) * 100) : 0;
  return `${top.name} holds ${share} percent of your assets`;
}

export function allocationTitle(rows) {
  const withValue = rows.filter((r) => r.fraction > 0).sort((a, b) => b.fraction - a.fraction);
  if (!withValue.length) return 'Nothing to allocate yet';
  const top = withValue[0];
  return `${top.name} is your largest category at ${Math.round(top.fraction * 100)} percent`;
}

export function goalsTitle(progressRows) {
  if (!progressRows.length) return 'No goals set yet';
  const behind = progressRows.filter((p) => p.status === 'behind' || p.status === 'overdue').length;
  if (behind === 0) return `All ${progressRows.length} goals are on pace or better`;
  return `${behind} of ${progressRows.length} goals ${behind === 1 ? 'is' : 'are'} behind pace`;
}

export function contributionsTitle(rows) {
  const active = rows.filter((r) => r.inPence || r.outPence);
  if (!active.length) return 'No money in or out in the last 12 months';
  const totalIn = rows.reduce((s, r) => s + r.inPence, 0);
  const totalOut = rows.reduce((s, r) => s + r.outPence, 0);
  const net = totalIn - totalOut;
  if (net === 0) return 'Money in matched money out over the last 12 months';
  const verb = net > 0 ? 'put in' : 'taken out';
  return `You ${verb} ${formatMoneyCompact(Math.abs(net))} more than you ${net > 0 ? 'took out' : 'put in'} this year`;
}

export function monthlyNetTitle(rows) {
  const active = rows.filter((r) => r.inPence || r.outPence);
  if (!active.length) return 'No activity to summarise yet';
  const positive = active.filter((r) => r.netPence > 0).length;
  return `You saved money in ${positive} of the last ${active.length} active months`;
}

export function holdingsTitle(rows) {
  if (!rows.length) return 'No quantity based holdings yet';
  const stale = rows.filter((r) => r.stale).length;
  if (stale) return `${stale} of ${rows.length} unit prices are more than 7 days old`;
  return `All ${rows.length} unit prices are up to date`;
}

export function categoryTotalsTitle(rows) {
  const withValue = rows.filter((r) => r.valuePence > 0);
  if (!withValue.length) return 'No category holds a balance yet';
  return `${withValue[0].name} leads on ${formatMoneyCompact(withValue[0].valuePence)}`;
}
