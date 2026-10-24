/**
 * charts.js
 *
 * Every chart is inline SVG built here as a string. No charting library,
 * no canvas, no dependencies. Charts are drawn at real pixel size, so a
 * 12 unit label really is 12 pixels on a narrow phone.
 *
 * The rules applied throughout:
 *   - colour has one job per visual: the accent for a single series, the
 *     category colours only on the allocation bar, green and red only for
 *     money in and money out, red for debt
 *   - bar and column axes start at zero, bars are sorted by value
 *   - bars are thin, with a 4px rounded data end and a square baseline
 *   - touching marks are separated by a 2px gap, never by a border
 *   - text wears text colours, never the colour of the data
 *   - one hairline grid at most, no shadows, no fills behind the plot
 *   - every chart has a table of its numbers one tap away
 *   - nothing ever renders blank
 */

import {
  CATEGORIES,
  RANGE_PRESETS,
  VISUAL_LIBRARY,
  activeAccounts,
  allocationByCategory,
  allocationTitle,
  balancesAt,
  buildDailySeries,
  categoryKey,
  categoryTotals,
  categoryTotalsTitle,
  contributionsByMonth,
  contributionsTitle,
  daysBetween,
  describeTimeRemaining,
  formatMoney,
  formatUnits,
  goalProgress,
  goalsTitle,
  holdingsTitle,
  monthKey,
  monthlyNetTitle,
  netWorthTitle,
  niceScale,
  positionSeries,
  positionTitle,
  rangeStartDate,
  sampleSeries,
  seriesChange
} from './logic.js';

import { categoryGlyph, icon } from './icons.js';

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

export function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

export function longDate(iso) {
  const [y, m, d] = String(iso).split('-');
  return `${Number(d)} ${MONTHS_LONG[Number(m) - 1]} ${y}`;
}

export function shortDate(iso) {
  const [y, m, d] = String(iso).split('-');
  return `${Number(d)} ${MONTHS_SHORT[Number(m) - 1]} ${y}`;
}

function monthName(key) {
  const [y, m] = String(key).split('-');
  return { short: MONTHS_SHORT[Number(m) - 1], long: `${MONTHS_LONG[Number(m) - 1]} ${y}` };
}

/** Rough text width so labels can be trimmed before they collide. */
function textWidth(text, fontSize, bold = false) {
  return String(text).length * fontSize * (bold ? 0.58 : 0.54);
}

function trimTo(text, fontSize, maxWidth, bold = false) {
  const str = String(text);
  if (textWidth(str, fontSize, bold) <= maxWidth) return str;
  const room = Math.max(1, Math.floor(maxWidth / (fontSize * (bold ? 0.58 : 0.54))) - 1);
  return `${str.slice(0, room)}…`;
}

/**
 * A formatter for one axis. Ticks drop the pence, and abbreviation follows
 * the house rule of only applying above ten thousand pounds, decided once
 * for the whole axis: an axis reading £12k, £10k, £8,000 mixes two styles,
 * so when the top tick needs a k, every tick on that axis gets one.
 */
function axisFormatter(ticks) {
  const top = Math.max(...ticks.map((t) => Math.abs(t)));
  if (top < 1000000) return (pence) => formatMoney(pence, { showPence: false });
  const useM = top >= 100000000;
  return (pence) => {
    if (pence === 0) return '£0';
    const sign = pence < 0 ? '-' : '';
    const pounds = Math.abs(pence) / 100;
    const n = useM ? pounds / 1000000 : pounds / 1000;
    const text = String(Math.round(n * 10) / 10);
    return `${sign}£${text}${useM ? 'm' : 'k'}`;
  };
}

function gutterFor(ticks, format, fontSize = 11.5) {
  const widest = Math.max(...ticks.map((t) => textWidth(format(t), fontSize)));
  return Math.ceil(Math.max(28, Math.min(96, widest + 10)));
}

let idCounter = 0;
function uid(prefix) {
  idCounter += 1;
  return `${prefix}${idCounter}`;
}

/** A category badge: a coloured circle carrying the category glyph. */
export function badge(category, size = '') {
  const key = categoryKey(category);
  return `<span class="badge badge-${key}${size ? ` is-${size}` : ''}" aria-hidden="true">${categoryGlyph(key)}</span>`;
}

/** Tooltip data on a mark. The value leads, the label follows. */
function tip(value, label) {
  return `tabindex="0" role="img" aria-label="${esc(`${label}: ${value}`)}" `
    + `data-tip-value="${esc(value)}" data-tip-label="${esc(label)}"`;
}

/* ------------------------------------------------------------------ */
/* Mark geometry                                                       */
/* ------------------------------------------------------------------ */

/** A horizontal bar with a 4px rounded data end and a square baseline. */
function hBarPath(x, y, w, h, end = 'right') {
  if (w <= 0) return '';
  const r = Math.min(4, h / 2, w);
  const f = (n) => n.toFixed(1);
  if (end === 'right') {
    return `M${f(x)},${f(y)}H${f(x + w - r)}A${r},${r} 0 0 1 ${f(x + w)},${f(y + r)}`
      + `V${f(y + h - r)}A${r},${r} 0 0 1 ${f(x + w - r)},${f(y + h)}H${f(x)}Z`;
  }
  return `M${f(x + w)},${f(y)}H${f(x + r)}A${r},${r} 0 0 0 ${f(x)},${f(y + r)}`
    + `V${f(y + h - r)}A${r},${r} 0 0 0 ${f(x + r)},${f(y + h)}H${f(x + w)}Z`;
}

/** A column with a rounded data end: at the top when up, the bottom when down. */
function vBarPath(x, y, w, h, end = 'up') {
  if (h <= 0 || w <= 0) return '';
  const r = Math.min(4, w / 2, h);
  const f = (n) => n.toFixed(1);
  if (end === 'up') {
    return `M${f(x)},${f(y + h)}V${f(y + r)}A${r},${r} 0 0 1 ${f(x + r)},${f(y)}`
      + `H${f(x + w - r)}A${r},${r} 0 0 1 ${f(x + w)},${f(y + r)}V${f(y + h)}Z`;
  }
  return `M${f(x)},${f(y)}V${f(y + h - r)}A${r},${r} 0 0 0 ${f(x + r)},${f(y + h)}`
    + `H${f(x + w - r)}A${r},${r} 0 0 0 ${f(x + w)},${f(y + h - r)}V${f(y)}Z`;
}

function svgOpen(width, height, label, extra = '') {
  return `<svg class="chart" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" `
    + `role="img" aria-label="${esc(label)}" xmlns="http://www.w3.org/2000/svg"${extra}>`;
}

function emptyChart(title, hint) {
  return `<div class="chart-empty"><p class="chart-empty-title">${esc(title)}</p>`
    + `<p class="chart-empty-hint">${esc(hint)}</p></div>`;
}

/** The table twin of a chart, so no value is ever only reachable by hovering. */
function tableView(caption, headers, rows) {
  if (!rows.length) return '';
  return `<details class="table-view"><summary>Show the numbers</summary>
    <table class="data-table">
      <caption class="visually-hidden">${esc(caption)}</caption>
      <thead><tr>${headers.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></details>`;
}

function legend(items) {
  return `<ul class="legend">${items.map((item) => `
    <li><span class="legend-swatch" style="background:${item.colour}"></span>
      <span class="legend-name">${esc(item.name)}</span>
      ${item.value ? `<span class="legend-value">${esc(item.value)}</span>` : ''}</li>`).join('')}</ul>`;
}

/* ------------------------------------------------------------------ */
/* Line chart, shared by net worth and by each account                 */
/*                                                                     */
/* The plotted points ride along on the SVG so the page can draw a     */
/* crosshair that snaps to the nearest day as a finger moves.          */
/* ------------------------------------------------------------------ */

export function lineChart({ series, width, height = 190, label, onCanvas = false }) {
  if (!series || series.length < 2) return '';
  const padTop = 22;
  const padBottom = 26;
  const plotH = height - padTop - padBottom;
  const plotW = Math.max(40, width - 4);

  const values = series.map((p) => p.value);
  // A line axis may be truncated, but only with its values labelled, so the
  // tick labels below always carry real figures.
  const scale = niceScale(Math.min(...values), Math.max(...values), 3);
  const span = (scale.max - scale.min) || 1;

  const points = sampleSeries(series, Math.max(2, Math.min(200, Math.floor(plotW / 2))));
  const x = (i) => 2 + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v) => padTop + plotH - (((v - scale.min) / span) * plotH);

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
  const floor = (padTop + plotH).toFixed(1);
  const area = `${line}L${x(points.length - 1).toFixed(1)},${floor}L${x(0).toFixed(1)},${floor}Z`;
  const gradient = uid('fill');

  const tickText = axisFormatter(scale.ticks);
  const visibleTicks = scale.ticks.filter((t) => y(t) >= padTop - 1 && y(t) <= padTop + plotH + 1);
  const grid = visibleTicks.map((t) =>
    `<line class="gridline" x1="0" x2="${width}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/>`).join('');
  // Tick labels are drawn after the line, with a halo in the background
  // colour, so a line passing underneath never hides a figure.
  const tickLabels = visibleTicks.map((t) =>
    `<text class="axis-label" x="0" y="${(y(t) - 5).toFixed(1)}">${esc(tickText(t))}</text>`).join('');

  const zero = scale.min < 0 && scale.max > 0
    ? `<line class="baseline" x1="0" x2="${width}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>` : '';

  const last = points[points.length - 1];
  const data = points.map((p, i) => [Math.round(x(i) * 10) / 10, Math.round(y(p.value) * 10) / 10, p.date, p.value]);

  return `${svgOpen(width, height, label, ` data-points="${esc(JSON.stringify(data))}"`)}
    <defs><linearGradient id="${gradient}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" style="stop-color:var(--accent);stop-opacity:0.26"/>
      <stop offset="1" style="stop-color:var(--accent);stop-opacity:0"/>
    </linearGradient></defs>
    ${grid}${zero}
    <path d="${area}" fill="url(#${gradient})"/>
    <path d="${line}" class="line-path"/>
    <circle class="line-end${onCanvas ? '' : ' on-surface'}" cx="${x(points.length - 1).toFixed(1)}" cy="${y(last.value).toFixed(1)}" r="4.5"/>
    ${tickLabels}
    <text class="axis-label" x="2" y="${height - 6}">${esc(shortDate(points[0].date))}</text>
    <text class="axis-label" x="${width - 2}" y="${height - 6}" text-anchor="end">${esc(shortDate(last.date))}</text>
    <g class="crosshair-group" visibility="hidden">
      <line class="crosshair" x1="0" x2="0" y1="${padTop - 6}" y2="${padTop + plotH}"/>
      <circle class="crosshair-dot" cx="0" cy="0" r="6"/>
    </g>
    <rect class="scrub-target" x="0" y="0" width="${width}" height="${height}" fill="transparent"/>
  </svg>`;
}

/** Month end values, for the table twin of a daily line. */
function monthEnds(series) {
  const byMonth = new Map();
  for (const p of series) byMonth.set(monthKey(p.date), p);
  return Array.from(byMonth.values());
}

/* ------------------------------------------------------------------ */
/* Home: the net worth hero                                            */
/* ------------------------------------------------------------------ */

const RANGE_SHORT = { '1m': '1M', '6m': '6M', '1y': '1Y', all: 'All' };
const RANGE_PERIOD = { '1m': 'past month', '6m': 'past 6 months', '1y': 'past year', all: 'since you started' };

export function heroBlock({ state, today, width }) {
  const rangeKey = RANGE_PRESETS[state.settings && state.settings.netWorthRange]
    ? state.settings.netWorthRange : '1y';
  const from = rangeStartDate(rangeKey, state, today);
  const daily = buildDailySeries(state, { today, fromDate: from });
  const series = daily.map((p) => ({ date: p.date, value: p.netWorthPence }));
  const change = seriesChange(daily);
  const current = daily.length ? daily[daily.length - 1].netWorthPence : 0;
  const title = netWorthTitle(daily, rangeKey);

  const direction = change.absolutePence > 0 ? 'is-positive' : change.absolutePence < 0 ? 'is-negative' : 'is-flat';
  const arrow = change.absolutePence > 0 ? icon.trendUp : change.absolutePence < 0 ? icon.trendDown : '';

  const ranges = Object.keys(RANGE_PRESETS).map((key) => `
    <button type="button" data-action="set-range" data-range="${key}" aria-pressed="${key === rangeKey}"
            aria-label="${esc(RANGE_PRESETS[key].label)}">${RANGE_SHORT[key]}</button>`).join('');

  const hasHistory = state.transactions.length > 0 && series.length >= 2;
  const chart = hasHistory
    ? lineChart({ series, width, height: 190, label: title, onCanvas: true })
    : emptyChart('No history to plot yet', 'Add money to an account and the line starts here.');

  const table = hasHistory
    ? tableView('Net worth at the end of each month',
      ['Month', 'Net worth'],
      monthEnds(series).map((p) => [monthName(monthKey(p.date)).long, formatMoney(p.value)]))
    : '';

  return `
    <section class="hero" aria-label="Net worth">
      <p class="hero-label">Net worth</p>
      <p class="hero-value" id="hero-value">${esc(formatMoney(current))}</p>
      <div class="hero-meta">
        <span class="delta-chip ${direction}">${arrow}${esc(formatMoney(change.absolutePence, { showSign: change.absolutePence !== 0 }))}</span>
        <span class="hero-period">${esc(RANGE_PERIOD[rangeKey])}</span>
      </div>
      <p class="hero-readout" data-readout data-default="${esc(title)}">${esc(title)}</p>
    </section>
    <div class="hero-chart" data-scrub>${chart}</div>
    <div class="range" role="group" aria-label="Time range">${ranges}</div>
    ${table}`;
}

/* ------------------------------------------------------------------ */
/* Insights visuals                                                    */
/* ------------------------------------------------------------------ */

export function positionVisual({ state, today, width }) {
  const rows = positionSeries(state, today).filter((r) => r.magnitudePence > 0);
  if (!rows.length) {
    return { title: positionTitle([]), body: emptyChart('No balances yet', 'Add money to an account to see it here.') };
  }

  const rowHeight = 46;
  const barH = 12;
  const height = rows.length * rowHeight;
  const maxAsset = Math.max(0, ...rows.map((r) => (r.valuePence > 0 ? r.valuePence : 0)));
  const maxDebt = Math.max(0, ...rows.map((r) => (r.valuePence < 0 ? -r.valuePence : 0)));
  const total = (maxAsset + maxDebt) || 1;
  const plotW = width - 2;
  // Bars grow from one baseline. It sits far enough right to give any debt
  // room to run the other way.
  const zeroX = 1 + (maxDebt / total) * plotW;
  const length = (pence) => (Math.abs(pence) / total) * plotW;

  const marks = rows.map((row, i) => {
    const top = i * rowHeight;
    const isDebt = row.valuePence < 0;
    const value = formatMoney(row.valuePence);
    const w = Math.max(2, length(row.valuePence));
    const path = isDebt ? hBarPath(zeroX - w, top + 24, w, barH, 'left') : hBarPath(zeroX, top + 24, w, barH, 'right');
    const detail = row.type === 'quantity' ? `${formatUnits(row.unitsE8, 6)} ${row.unit || 'units'} at ${formatMoney(row.pricePence)}` : row.category;
    return `
      <text class="bar-name" x="1" y="${top + 15}">${esc(trimTo(row.name, 13.5, plotW - textWidth(value, 13.5) - 16, true))}</text>
      <text class="bar-value${isDebt ? ' is-negative' : ''}" x="${plotW}" y="${top + 15}" text-anchor="end">${esc(value)}</text>
      <path class="mark" d="${path}" fill="${isDebt ? 'var(--negative)' : 'var(--accent)'}" ${tip(value, `${row.name}, ${detail}`)}/>`;
  }).join('');

  const body = `${svgOpen(width, height, 'Every account by value, largest first, with debt to the left of the baseline')}
      ${marks}
      <line class="baseline" x1="${zeroX.toFixed(1)}" x2="${zeroX.toFixed(1)}" y1="20" y2="${height - 6}"/>
    </svg>
    ${maxDebt > 0 ? '<p class="chart-note">Debt runs to the left of the baseline, in red.</p>' : ''}
    ${tableView('Every account by value', ['Account', 'Category', 'Value'],
    rows.map((r) => [r.name, r.category, formatMoney(r.valuePence)]))}`;

  return { title: positionTitle(rows), body };
}

export function allocationVisual({ state, today, width }) {
  const all = allocationByCategory(state, today);
  const rows = all.filter((r) => r.fraction > 0);
  if (!rows.length) {
    return { title: allocationTitle([]), body: emptyChart('Nothing to allocate yet', 'Add money to an account to see the split.') };
  }

  const barH = 22;
  const gap = 2;
  const plotW = width;
  const usable = plotW - gap * (rows.length - 1);
  const clip = uid('clip');
  let cursor = 0;
  const segments = rows.map((row, i) => {
    const w = Math.max(2, row.fraction * usable);
    const x = cursor;
    cursor += w + gap;
    const pct = `${Math.round(row.fraction * 100)}%`;
    // The last segment takes up any rounding slack so the bar ends flush.
    const segW = i === rows.length - 1 ? Math.max(2, plotW - x) : w;
    return `<rect class="mark" x="${x.toFixed(1)}" y="0" width="${segW.toFixed(1)}" height="${barH}"
      fill="var(--cat-${row.key})" ${tip(`${pct}, ${formatMoney(row.valuePence)}`, row.name)}/>`;
  }).join('');

  // Segments sit in one fixed, colour checked order, so only checked
  // neighbours ever touch. Labels go in the legend, never inside a segment.
  const body = `${svgOpen(width, barH, 'Share of assets in each category')}
      <defs><clipPath id="${clip}"><rect x="0" y="0" width="${plotW}" height="${barH}" rx="6"/></clipPath></defs>
      <g clip-path="url(#${clip})">${segments}</g>
    </svg>
    ${legend(rows.map((r) => ({ name: r.name, value: `${Math.round(r.fraction * 100)}%`, colour: `var(--cat-${r.key})` })))}
    ${tableView('Share of assets in each category', ['Category', 'Share', 'Value'],
    rows.map((r) => [r.name, `${(r.fraction * 100).toFixed(1)}%`, formatMoney(r.valuePence)]))}`;

  return { title: allocationTitle(all), body };
}

const STATUS_LABELS = {
  exceeded: { text: 'Target passed', tone: 'is-good', glyph: 'check' },
  reached: { text: 'Target reached', tone: 'is-good', glyph: 'check' },
  overdue: { text: 'Date has passed', tone: 'is-bad', glyph: 'alert' },
  ahead: { text: 'Ahead of pace', tone: 'is-good', glyph: 'trendUp' },
  behind: { text: 'Behind pace', tone: 'is-bad', glyph: 'alert' },
  'on track': { text: 'On pace', tone: 'is-info', glyph: 'check' },
  'in progress': { text: 'In progress', tone: '', glyph: 'clock' }
};

/** A status always carries an icon and words, never colour alone. */
export function statusChip(status) {
  const s = STATUS_LABELS[status] || STATUS_LABELS['in progress'];
  return `<span class="status ${s.tone}">${icon[s.glyph]}${esc(s.text)}</span>`;
}

function bulletBar(width, progress) {
  const h = 10;
  const top = 6;
  const fill = Math.max(0, Math.min(1, progress.fraction)) * width;
  const pace = progress.pace && !progress.reached
    ? Math.max(1, Math.min(width - 1, progress.pace.elapsedFraction * width)) : null;
  return `${svgOpen(width, h + top * 2, `${Math.round(progress.percent)} percent of the target`)}
    <rect class="goal-track" x="0" y="${top}" width="${width}" height="${h}" rx="${h / 2}"/>
    ${fill > 0 ? `<path d="${hBarPath(0, top, Math.max(fill, h / 2), h, 'right')}" fill="var(--accent)"/>` : ''}
    ${pace === null ? '' : `
      <line class="pace-halo" x1="${pace.toFixed(1)}" x2="${pace.toFixed(1)}" y1="2" y2="${h + top * 2 - 2}"/>
      <line class="pace-marker" x1="${pace.toFixed(1)}" x2="${pace.toFixed(1)}" y1="2" y2="${h + top * 2 - 2}"/>`}
  </svg>`;
}

export function goalsVisual({ state, today, width }) {
  const balances = balancesAt(state, today);
  const withGoals = activeAccounts(state).filter((a) => a.goal);
  if (!withGoals.length) {
    return { title: goalsTitle([]), body: emptyChart('No goals set yet', 'Open an account and set a target amount and date.') };
  }

  const progressRows = [];
  const tableRows = [];
  const blocks = withGoals.map((account) => {
    const entry = balances.get(account.id) || { valuePence: 0 };
    const p = goalProgress(account, entry.valuePence, today);
    if (!p) return '';
    progressRows.push(p);
    const pct = p.exceeded ? `${Math.round(p.rawPercent)}%` : `${Math.round(p.percent)}%`;
    const amount = p.isDebt
      ? `${formatMoney(p.currentPence)} still owed`
      : `${formatMoney(p.currentPence)} of ${formatMoney(p.targetPence)}`;
    const facts = [];
    if (p.remainingPence > 0) facts.push(`${formatMoney(p.remainingPence)} to go`);
    if (p.timeRemaining && !p.overdue) facts.push(`${describeTimeRemaining(p.timeRemaining)} left`);
    if (p.overdue) facts.push(`target was ${shortDate(p.targetDate)}`);
    if (p.rates.achievable && p.remainingPence > 0) facts.push(`${formatMoney(p.rates.perMonthPence)} a month`);
    tableRows.push([
      account.name,
      formatMoney(p.currentPence),
      formatMoney(p.targetPence),
      pct,
      p.pace ? formatMoney(p.pace.expectedPence) : ''
    ]);
    return `
      <div class="goal-row">
        <div class="goal-row-head">
          <span class="goal-row-name">${esc(account.name)}</span>
          ${statusChip(p.status)}
        </div>
        <div class="progress-row" style="margin:0 0 2px"><span>${esc(amount)}</span><span>${esc(pct)}</span></div>
        <div ${tip(`${pct} reached`, `${account.name}. The upright line is where a straight line says you should be today`)}>
          ${bulletBar(width, p)}
        </div>
        <p class="progress-row" style="justify-content:flex-start">${esc(facts.join(' · '))}</p>
      </div>`;
  }).join('');

  const body = `${blocks}
    <p class="chart-note">The upright line on each bar marks where you would be today on a straight line from the start of the goal to its date.</p>
    ${tableView('Progress on every goal', ['Goal', 'Saved', 'Target', 'Reached', 'On pace would be'], tableRows)}`;
  return { title: goalsTitle(progressRows), body };
}

function columnChart({ rows, width, label, series }) {
  // series: [{ key, colour, name }] read from each row by key.
  const height = 200;
  const padBottom = 30;
  const padTop = 12;
  const values = rows.flatMap((r) => series.map((s) => r[s.key]));
  const min = Math.min(0, ...values);
  const max = Math.max(1, ...values);
  // Column axes always include zero.
  const scale = niceScale(min, max, 3);
  const tickText = axisFormatter(scale.ticks);
  const padLeft = gutterFor(scale.ticks, tickText);
  const plotW = Math.max(40, width - padLeft);
  const plotH = height - padTop - padBottom;
  const span = (scale.max - scale.min) || 1;
  const y = (v) => padTop + plotH - (((v - scale.min) / span) * plotH);
  const zeroY = y(0);

  const slot = plotW / rows.length;
  const groupGap = 2;
  const barW = Math.max(3, Math.min(series.length > 1 ? 10 : 18, (slot - 6 - groupGap * (series.length - 1)) / series.length));
  const groupW = barW * series.length + groupGap * (series.length - 1);

  const grid = scale.ticks.map((t) => `
    <line class="${t === 0 ? 'baseline' : 'gridline'}" x1="${padLeft}" x2="${width}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/>
    <text class="axis-label" x="${padLeft - 6}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${esc(tickText(t))}</text>`).join('');

  const marks = rows.map((row, i) => {
    const left = padLeft + i * slot + (slot - groupW) / 2;
    return series.map((s, j) => {
      const v = row[s.key];
      const x = left + j * (barW + groupGap);
      const up = v >= 0;
      const top = up ? y(v) : zeroY;
      const h = Math.abs(y(v) - zeroY);
      if (h < 0.5) return '';
      const colour = typeof s.colour === 'function' ? s.colour(v) : s.colour;
      return `<path class="mark" d="${vBarPath(x, top, barW, h, up ? 'up' : 'down')}" fill="${colour}"
        ${tip(formatMoney(v, { showSign: s.signed }), `${s.name}, ${monthName(row.month).long}`)}/>`;
    }).join('');
  }).join('');

  const everyOther = slot < 28;
  const labels = rows.map((row, i) => {
    if (everyOther && (rows.length - 1 - i) % 2 !== 0) return '';
    return `<text class="axis-label" x="${(padLeft + i * slot + slot / 2).toFixed(1)}" y="${height - 8}" text-anchor="middle">${esc(monthName(row.month).short)}</text>`;
  }).join('');

  return `${svgOpen(width, height, label)}${grid}${marks}${labels}</svg>`;
}

export function contributionsVisual({ state, today, width }) {
  const rows = contributionsByMonth(state, { today, months: 12 });
  if (!rows.some((r) => r.inPence || r.outPence)) {
    return { title: contributionsTitle(rows), body: emptyChart('No money in or out yet', 'Add or withdraw money and the months fill in here.') };
  }
  const chart = columnChart({
    rows,
    width,
    label: 'Money in against money out for each of the last twelve months',
    series: [
      { key: 'inPence', name: 'Money in', colour: 'var(--positive)' },
      { key: 'outPence', name: 'Money out', colour: 'var(--negative)' }
    ]
  });
  const body = `${chart}
    ${legend([{ name: 'Money in', colour: 'var(--positive)' }, { name: 'Money out', colour: 'var(--negative)' }])}
    ${tableView('Money in and out by month', ['Month', 'In', 'Out', 'Net'],
    rows.map((r) => [monthName(r.month).long, formatMoney(r.inPence), formatMoney(r.outPence), formatMoney(r.netPence, { showSign: r.netPence !== 0 })]))}`;
  return { title: contributionsTitle(rows), body };
}

export function monthlyNetVisual({ state, today, width }) {
  const rows = contributionsByMonth(state, { today, months: 12 });
  if (!rows.some((r) => r.inPence || r.outPence)) {
    return { title: monthlyNetTitle(rows), body: emptyChart('Nothing saved yet', 'Add money and each month appears here.') };
  }
  const chart = columnChart({
    rows,
    width,
    label: 'Money left over each month',
    series: [{
      key: 'netPence',
      name: 'Saved',
      signed: true,
      colour: (v) => (v >= 0 ? 'var(--positive)' : 'var(--negative)')
    }]
  });
  const body = `${chart}
    ${legend([{ name: 'Saved', colour: 'var(--positive)' }, { name: 'Spent more than you put in', colour: 'var(--negative)' }])}
    ${tableView('Net saved by month', ['Month', 'Net'],
    rows.map((r) => [monthName(r.month).long, formatMoney(r.netPence, { showSign: r.netPence !== 0 })]))}`;
  return { title: monthlyNetTitle(rows), body };
}

export function holdingsVisual({ state, today }) {
  const balances = balancesAt(state, today);
  const rows = activeAccounts(state)
    .filter((a) => a.type === 'quantity')
    .map((account) => {
      const entry = balances.get(account.id) || { valuePence: 0, unitsE8: 0, pricePence: 0 };
      const age = account.priceUpdatedAt ? daysBetween(account.priceUpdatedAt, today) : null;
      return { account, ...entry, ageDays: age, stale: age === null || age > 7 };
    })
    .sort((a, b) => b.valuePence - a.valuePence);

  if (!rows.length) {
    return { title: holdingsTitle([]), body: emptyChart('No quantity based holdings', 'Add an account that tracks units and a unit price.') };
  }

  const items = rows.map((row) => {
    const age = row.ageDays === null ? 'Price never set'
      : row.ageDays === 0 ? 'Price updated today'
        : `Price ${row.ageDays} day${row.ageDays === 1 ? '' : 's'} old`;
    return `
      <button type="button" class="list-row" data-action="open-account" data-arg="${esc(row.account.id)}">
        ${badge(row.account.category, 'small')}
        <span class="row-main">
          <span class="row-title">${esc(row.account.name)}</span>
          <span class="row-sub">${esc(formatUnits(row.unitsE8, 6))} ${esc(row.account.unit || 'units')} at ${esc(formatMoney(row.pricePence))}</span>
        </span>
        <span class="row-end">
          <span class="row-amount">${esc(formatMoney(row.valuePence))}</span>
          <span class="row-sub">${row.stale ? `<span class="is-warning-text">${esc(age)}</span>` : esc(age)}</span>
        </span>
      </button>`;
  }).join('');

  return { title: holdingsTitle(rows), body: `<div class="list-group is-inset">${items}</div>` };
}

export function categoryTotalsVisual({ state, today, width }) {
  const totals = categoryTotals(state, today);
  const rows = CATEGORIES
    .map((name) => ({ name, valuePence: name === 'Debt' ? -(totals[name] || 0) : (totals[name] || 0) }))
    .filter((r) => r.valuePence !== 0)
    .sort((a, b) => b.valuePence - a.valuePence);

  if (!rows.length) {
    return { title: categoryTotalsTitle([]), body: emptyChart('No category totals yet', 'Add money to an account first.') };
  }

  const rowHeight = 44;
  const barH = 12;
  const height = rows.length * rowHeight;
  const plotW = width - 2;
  const max = Math.max(...rows.map((r) => Math.abs(r.valuePence)));
  const marks = rows.map((row, i) => {
    const top = i * rowHeight;
    const isDebt = row.valuePence < 0;
    const value = formatMoney(row.valuePence);
    const w = Math.max(2, (Math.abs(row.valuePence) / max) * plotW);
    return `
      <text class="bar-name" x="1" y="${top + 15}">${esc(row.name)}</text>
      <text class="bar-value${isDebt ? ' is-negative' : ''}" x="${plotW}" y="${top + 15}" text-anchor="end">${esc(value)}</text>
      <path class="mark" d="${hBarPath(1, top + 23, w, barH, 'right')}" fill="${isDebt ? 'var(--negative)' : 'var(--accent)'}" ${tip(value, row.name)}/>`;
  }).join('');

  return {
    title: categoryTotalsTitle(rows),
    body: `${svgOpen(width, height, 'Total held in each category, largest first')}${marks}</svg>
      ${tableView('Total in each category', ['Category', 'Total'], rows.map((r) => [r.name, formatMoney(r.valuePence)]))}`
  };
}

/* ------------------------------------------------------------------ */
/* Dispatch                                                            */
/* ------------------------------------------------------------------ */

export const RENDERERS = {
  position: positionVisual,
  allocation: allocationVisual,
  goals: goalsVisual,
  contributions: contributionsVisual,
  monthlyNet: monthlyNetVisual,
  holdings: holdingsVisual,
  categoryTotals: categoryTotalsVisual
};

/**
 * Render one visual. A renderer that throws is caught here and turned into
 * a visible message rather than an empty card or a broken page.
 */
export function renderVisual(id, ctx) {
  const renderer = RENDERERS[id];
  const meta = VISUAL_LIBRARY[id] || { name: id };
  if (!renderer) {
    return { title: meta.name, body: '<p class="chart-error">This visual is not available.</p>', failed: true };
  }
  try {
    return { ...renderer(ctx), failed: false };
  } catch (error) {
    return {
      title: meta.name,
      body: `<p class="chart-error">This chart could not be drawn: ${esc(error.message)}. `
        + 'Everything else still works, and your data is untouched.</p>',
      failed: true
    };
  }
}
