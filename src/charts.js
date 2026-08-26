/**
 * charts.js
 *
 * Every chart is inline SVG built here as a string. No charting library,
 * no canvas, no dependencies.
 *
 * Charts are drawn at real pixel size rather than being scaled by the
 * browser, so a 12 unit label really is 12 pixels and nothing shrinks
 * below legibility on a narrow phone.
 *
 * House rules, applied throughout:
 *   - bar and column axes always start at zero
 *   - bars are sorted by value, never alphabetically
 *   - direct labels beat a legend wherever they fit
 *   - no gridlines beyond a single faint zero line, no shadows, no fills
 *     behind the plot area
 *   - nothing ever renders blank
 */

import {
  CATEGORIES,
  RANGE_PRESETS,
  VISUAL_LIBRARY,
  allocationByCategory,
  allocationTitle,
  balancesAt,
  buildDailySeries,
  categoryTotals,
  categoryTotalsTitle,
  contributionsByMonth,
  contributionsTitle,
  daysBetween,
  describeTimeRemaining,
  formatMoney,
  formatMoneyCompact,
  formatUnits,
  goalProgress,
  goalsTitle,
  holdingsTitle,
  monthlyNetTitle,
  netWorthTitle,
  niceScale,
  positionSeries,
  positionTitle,
  rangeStartDate,
  sampleSeries,
  seriesChange,
  activeAccounts
} from './logic.js';

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

/** Rough text width so labels can be trimmed before they collide. */
function textWidth(text, fontSize, bold = false) {
  return String(text).length * fontSize * (bold ? 0.58 : 0.54);
}

function trimTo(text, fontSize, maxWidth, bold = false) {
  const str = String(text);
  if (textWidth(str, fontSize, bold) <= maxWidth) return str;
  const perChar = fontSize * (bold ? 0.58 : 0.54);
  const room = Math.max(1, Math.floor(maxWidth / perChar) - 1);
  return `${str.slice(0, room)}…`;
}

/** An account colour is a CSS variable so it follows the theme. */
export function seriesVar(colourIndex) {
  const n = Number.isInteger(colourIndex) ? colourIndex : 5;
  return `var(--series-${((n % 11) + 11) % 11})`;
}

export function colourVarForRow(row) {
  return row.type === 'liability' ? 'var(--negative)' : seriesVar(row.colourIndex);
}

function tip(text) {
  return `tabindex="0" role="button" aria-label="${esc(text)}" data-tip="${esc(text)}"`;
}

function svgOpen(width, height, label) {
  return `<svg class="chart" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" `
    + `role="img" aria-label="${esc(label)}" xmlns="http://www.w3.org/2000/svg">`;
}

function emptyChart(width, height, message, hint) {
  const h = Math.max(110, Math.min(height, 160));
  return `${svgOpen(width, h, message)}
    <rect x="0.5" y="0.5" width="${width - 1}" height="${h - 1}" rx="10"
          fill="none" stroke="var(--hairline)" stroke-dasharray="4 4"/>
    <text x="${width / 2}" y="${h / 2 - 4}" text-anchor="middle" class="chart-empty-title">${esc(message)}</text>
    <text x="${width / 2}" y="${h / 2 + 16}" text-anchor="middle" class="chart-empty-hint">${esc(hint)}</text>
  </svg>`;
}

/**
 * Axis ticks drop the pence, which is never useful on a scale, and follow
 * the house rule of only abbreviating above ten thousand pounds.
 */
function axisMoney(pence) {
  return Math.abs(pence) >= 1000000 ? formatMoneyCompact(pence) : formatMoney(pence, { showPence: false });
}

/** Left gutter wide enough for the widest tick label, so nothing clips. */
function gutterFor(ticks, fontSize = 11.5) {
  const widest = Math.max(...ticks.map((t) => textWidth(axisMoney(t), fontSize)));
  return Math.ceil(Math.max(28, Math.min(96, widest + 10)));
}

function monthLabel(monthKeyValue) {
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const parts = String(monthKeyValue).split('-');
  return names[Number(parts[1]) - 1] || '';
}

function dayLabel(iso) {
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const parts = String(iso).split('-');
  return `${Number(parts[2])} ${names[Number(parts[1]) - 1]}`;
}

function longDate(iso) {
  const names = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  const parts = String(iso).split('-');
  return `${Number(parts[2])} ${names[Number(parts[1]) - 1]} ${parts[0]}`;
}

/* ------------------------------------------------------------------ */
/* 1. Net worth over time                                              */
/* ------------------------------------------------------------------ */

export function netWorthVisual(ctx) {
  const { state, today, width } = ctx;
  const rangeKey = (state.settings && state.settings.netWorthRange) || '1y';
  const from = rangeStartDate(rangeKey, state, today);
  const series = buildDailySeries(state, { today, fromDate: from });
  const change = seriesChange(series);
  const current = series.length ? series[series.length - 1].netWorthPence : 0;

  const ranges = Object.keys(RANGE_PRESETS).map((key) => `
    <button type="button" class="range-button${key === rangeKey ? ' is-active' : ''}"
            data-action="set-range" data-range="${key}"
            aria-pressed="${key === rangeKey}">${esc(RANGE_PRESETS[key].label)}</button>`).join('');

  const hasData = state.transactions.length > 0;
  const changeClass = change.absolutePence > 0 ? 'is-positive'
    : change.absolutePence < 0 ? 'is-negative' : 'is-flat';
  const changeText = change.hasBase
    ? `${formatMoney(change.absolutePence, { showSign: true })} (${change.absolutePence >= 0 ? '+' : ''}${(change.fraction * 100).toFixed(1)}%)`
    : formatMoney(change.absolutePence, { showSign: true });

  const header = `
    <div class="hero">
      <p class="hero-label">Net worth today</p>
      <p class="hero-value">${esc(formatMoney(current))}</p>
      <p class="hero-change ${changeClass}">${esc(changeText)}
        <span class="hero-period">over ${esc(RANGE_PRESETS[rangeKey].label.toLowerCase())}</span></p>
    </div>
    <div class="range-row" role="group" aria-label="Time range">${ranges}</div>`;

  if (!hasData || series.length < 2) {
    return {
      title: netWorthTitle(series, rangeKey),
      body: `${header}${emptyChart(width, 150,
        'No history to plot yet',
        'Add money to an account and the line starts here.')}`
    };
  }

  const height = 210;
  const padRight = 10;
  const padTop = 12;
  const padBottom = 26;

  const values = series.map((p) => p.netWorthPence);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  // A line chart axis may be truncated, but only with labelled values, so
  // the tick labels below always show the real numbers.
  const scale = niceScale(rawMin, rawMax, 3);
  const span = scale.max - scale.min || 1;
  const padLeft = gutterFor(scale.ticks);
  const plotW = Math.max(40, width - padLeft - padRight);
  const plotH = height - padTop - padBottom;

  const points = sampleSeries(series, Math.max(2, Math.min(180, Math.floor(plotW / 2))));
  const x = (i) => padLeft + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v) => padTop + plotH - (((v - scale.min) / span) * plotH);

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.netWorthPence).toFixed(1)}`).join(' ');
  const zeroY = scale.min <= 0 && scale.max >= 0 ? y(0) : null;
  const area = `${line} L${x(points.length - 1).toFixed(1)},${(zeroY === null ? padTop + plotH : zeroY).toFixed(1)} `
    + `L${x(0).toFixed(1)},${(zeroY === null ? padTop + plotH : zeroY).toFixed(1)} Z`;

  const ticks = scale.ticks.filter((_, i, arr) => arr.length <= 4 || i % Math.ceil(arr.length / 4) === 0);
  const axis = ticks.map((value) => `
    <text x="${padLeft - 6}" y="${(y(value) + 4).toFixed(1)}" text-anchor="end"
          class="axis-label">${esc(axisMoney(value))}</text>`).join('');

  const firstLabel = dayLabel(points[0].date);
  const lastLabel = dayLabel(points[points.length - 1].date);

  // Invisible hit areas so a tap anywhere along the line gives a tooltip.
  const hits = points.map((p, i) => {
    const slot = plotW / points.length;
    return `<rect x="${(x(i) - slot / 2).toFixed(1)}" y="${padTop}" width="${Math.max(6, slot).toFixed(1)}"
      height="${plotH}" fill="transparent" class="hit"
      ${tip(`${longDate(p.date)}: ${formatMoney(p.netWorthPence)}`)}/>`;
  }).join('');

  const last = points[points.length - 1];
  const body = `${header}
    ${svgOpen(width, height, `Net worth from ${longDate(points[0].date)} to ${longDate(last.date)}`)}
      ${zeroY !== null ? `<line x1="${padLeft}" y1="${zeroY.toFixed(1)}" x2="${padLeft + plotW}" y2="${zeroY.toFixed(1)}" class="zero-line"/>` : ''}
      ${axis}
      <path d="${area}" class="area-fill"/>
      <path d="${line}" class="line-path"/>
      <circle cx="${x(points.length - 1).toFixed(1)}" cy="${y(last.netWorthPence).toFixed(1)}" r="3.5" class="line-end"/>
      <text x="${padLeft}" y="${height - 8}" class="axis-label">${esc(firstLabel)}</text>
      <text x="${padLeft + plotW}" y="${height - 8}" text-anchor="end" class="axis-label">${esc(lastLabel)}</text>
      ${hits}
    </svg>`;

  return { title: netWorthTitle(series, rangeKey), body };
}

/* ------------------------------------------------------------------ */
/* 2. Combined position                                                */
/* ------------------------------------------------------------------ */

export function positionVisual(ctx) {
  const { state, today, width } = ctx;
  const rows = positionSeries(state, today).filter((r) => r.magnitudePence > 0);

  if (!rows.length) {
    return {
      title: positionTitle([]),
      body: emptyChart(width, 140, 'No balances yet',
        'Add money to an account to see it here.')
    };
  }

  const rowHeight = 40;
  const height = rows.length * rowHeight + 14;
  const maxAsset = Math.max(0, ...rows.map((r) => (r.valuePence > 0 ? r.valuePence : 0)));
  const maxDebt = Math.max(0, ...rows.map((r) => (r.valuePence < 0 ? -r.valuePence : 0)));
  const total = maxAsset + maxDebt || 1;

  // The zero line sits far enough right to give the debt room to run left.
  const plotW = width - 2;
  const zeroX = 1 + (maxDebt / total) * plotW;
  const scale = (pence) => (Math.abs(pence) / total) * plotW;

  const bars = rows.map((row, i) => {
    const top = i * rowHeight + 4;
    const barY = top + 20;
    const length = Math.max(2, scale(row.valuePence));
    const isDebt = row.valuePence < 0;
    const barX = isDebt ? zeroX - length : zeroX;
    const valueText = formatMoney(row.valuePence);
    const nameMax = plotW - textWidth(valueText, 12) - 16;
    const detail = row.type === 'quantity'
      ? ` (${formatUnits(row.unitsE8, 6)} ${row.unit || 'units'} at ${formatMoney(row.pricePence)})`
      : '';
    return `
      <text x="1" y="${top + 12}" class="bar-name">${esc(trimTo(row.name, 12, nameMax, true))}</text>
      <text x="${plotW}" y="${top + 12}" text-anchor="end"
            class="bar-value${isDebt ? ' is-negative' : ''}">${esc(valueText)}</text>
      <rect x="${barX.toFixed(1)}" y="${barY}" width="${length.toFixed(1)}" height="13" rx="2"
            fill="${colourVarForRow(row)}" class="bar"
            ${tip(`${row.name}: ${valueText}${detail}`)}/>`;
  }).join('');

  const body = `${svgOpen(width, height, 'Account values, largest first, with debt below the axis')}
      ${bars}
      <line x1="${zeroX.toFixed(1)}" y1="2" x2="${zeroX.toFixed(1)}" y2="${height - 8}" class="zero-line"/>
    </svg>
    ${maxDebt > 0 ? '<p class="chart-note">Bars to the left of the line are money you owe.</p>' : ''}`;

  return { title: positionTitle(rows), body };
}

/* ------------------------------------------------------------------ */
/* 3. Allocation by category                                           */
/* ------------------------------------------------------------------ */

export function allocationVisual(ctx) {
  const { state, today, width } = ctx;
  const rows = allocationByCategory(state, today).filter((r) => r.fraction > 0);

  if (!rows.length) {
    return {
      title: allocationTitle([]),
      body: emptyChart(width, 130, 'Nothing to allocate yet',
        'Add money to an account to see the split.')
    };
  }

  const barHeight = 34;
  const height = barHeight + 12;
  const plotW = width - 2;

  let cursor = 1;
  const segments = [];
  const keyItems = [];
  rows.forEach((row) => {
    const segWidth = Math.max(2, row.fraction * plotW);
    const percent = `${Math.round(row.fraction * 100)}%`;
    const label = `${row.name}: ${percent} (${formatMoney(row.valuePence)})`;
    const fits = segWidth > textWidth(percent, 12, true) + 18;
    segments.push(`
      <rect x="${cursor.toFixed(1)}" y="4" width="${segWidth.toFixed(1)}" height="${barHeight - 8}"
            fill="${categoryVar(row.name)}" class="bar segment" ${tip(label)}/>
      ${fits ? `<text x="${(cursor + segWidth / 2).toFixed(1)}" y="${barHeight / 2 + 4}"
            text-anchor="middle" class="segment-label"
            style="fill:${categoryTextVar(row.name)}">${esc(percent)}</text>` : ''}`);
    keyItems.push(`
      <li><span class="swatch" style="background:${categoryVar(row.name)}"></span>
        <span class="key-name">${esc(row.name)}</span>
        <span class="key-value">${esc(percent)}</span></li>`);
    cursor += segWidth;
  });

  const body = `${svgOpen(width, height, 'Share of assets held in each category')}
      ${segments.join('')}
    </svg>
    <ul class="chart-key">${keyItems.join('')}</ul>`;

  return { title: allocationTitle(rows), body };
}

function categoryVar(name) {
  const index = CATEGORIES.indexOf(name);
  if (name === 'Debt') return 'var(--negative)';
  const slots = { Crypto: 0, 'Precious metals': 3, 'Property savings': 5, Investments: 6, Cash: 7 };
  return seriesVar(slots[name] !== undefined ? slots[name] : index);
}

function categoryTextVar(name) {
  const slots = { Crypto: 0, 'Precious metals': 3, 'Property savings': 5, Investments: 6, Cash: 7 };
  const n = slots[name] !== undefined ? slots[name] : 5;
  return `var(--series-${n}-text)`;
}

/* ------------------------------------------------------------------ */
/* 4. Goal progress                                                    */
/* ------------------------------------------------------------------ */

export function goalsVisual(ctx) {
  const { state, today, width } = ctx;
  const balances = balancesAt(state, today);
  const withGoals = activeAccounts(state).filter((a) => a.goal);

  if (!withGoals.length) {
    return {
      title: goalsTitle([]),
      body: emptyChart(width, 130, 'No goals set yet',
        'Open an account and set a target amount and date.')
    };
  }

  const progressRows = [];
  const blocks = withGoals.map((account) => {
    const entry = balances.get(account.id) || { valuePence: 0 };
    const progress = goalProgress(account, entry.valuePence, today);
    if (!progress) return '';
    progressRows.push(progress);

    const plotW = width - 2;
    const trackY = 22;
    const trackH = 14;
    const fillW = Math.max(0, Math.min(1, progress.fraction)) * plotW;
    const paceFraction = progress.pace
      ? Math.max(0, Math.min(1, progress.pace.elapsedFraction))
      : null;
    const paceX = paceFraction === null ? null : 1 + (paceFraction * plotW);

    const statusLabel = {
      exceeded: 'Passed the target',
      reached: 'Target reached',
      overdue: 'Date has passed',
      ahead: 'Ahead of pace',
      behind: 'Behind pace',
      'on track': 'On pace',
      'in progress': 'In progress'
    }[progress.status] || progress.status;

    const currentText = progress.isDebt
      ? `${formatMoney(progress.currentPence)} still owed`
      : `${formatMoney(progress.currentPence)} of ${formatMoney(progress.targetPence)}`;

    const percentText = progress.exceeded
      ? `${Math.round(progress.rawPercent)}% (target passed)`
      : `${Math.round(progress.percent)}%`;

    const facts = [];
    if (progress.remainingPence > 0) {
      facts.push(`<div><dt>Still needed</dt><dd>${esc(formatMoney(progress.remainingPence))}</dd></div>`);
    }
    if (progress.targetDate) {
      const tr = progress.timeRemaining;
      facts.push(`<div><dt>${progress.overdue ? 'Target date' : 'Time left'}</dt>
        <dd>${esc(progress.overdue ? `${longDate(progress.targetDate)} (${describeTimeRemaining(tr)})` : describeTimeRemaining(tr))}</dd></div>`);
    }
    if (progress.rates.achievable && progress.remainingPence > 0) {
      facts.push(`<div><dt>Per day</dt><dd>${esc(formatMoney(progress.rates.perDayPence))}</dd></div>`);
      facts.push(`<div><dt>Per week</dt><dd>${esc(formatMoney(progress.rates.perWeekPence))}</dd></div>`);
      facts.push(`<div><dt>Per month</dt><dd>${esc(formatMoney(progress.rates.perMonthPence))}</dd></div>`);
    } else if (!progress.rates.achievable && progress.remainingPence > 0) {
      facts.push(`<div class="wide"><dt>Saving rate</dt>
        <dd>The target date has passed, so there is no rate that arrives on time. Set a new date.</dd></div>`);
    }
    if (progress.pace && !progress.reached) {
      const diff = Math.abs(progress.pace.differencePence);
      const word = progress.pace.status === 'behind' ? 'behind' : progress.pace.status === 'ahead' ? 'ahead of' : 'level with';
      facts.push(`<div class="wide"><dt>Against pace</dt>
        <dd>${esc(formatMoney(diff))} ${esc(word)} where a straight line says you should be today
        (${esc(formatMoney(progress.pace.expectedPence))}).</dd></div>`);
    }
    if (progress.isDebt && account.interestRatePct) {
      facts.push(`<div><dt>Interest</dt><dd>${esc(account.interestRatePct)}% a year</dd></div>`);
    }

    return `
      <div class="goal-block">
        <div class="goal-head">
          <span class="goal-name">${esc(account.name)}</span>
          <span class="goal-status status-${esc(progress.status.replace(/\s+/g, '-'))}">${esc(statusLabel)}</span>
        </div>
        ${svgOpen(width, 44, `${account.name}: ${percentText} of the target`)}
          <text x="1" y="12" class="bar-name">${esc(currentText)}</text>
          <text x="${width - 2}" y="12" text-anchor="end" class="bar-value">${esc(percentText)}</text>
          <rect x="1" y="${trackY}" width="${plotW}" height="${trackH}" rx="3" class="goal-track"/>
          <rect x="1" y="${trackY}" width="${fillW.toFixed(1)}" height="${trackH}" rx="3"
                fill="${account.type === 'liability' ? 'var(--negative)' : seriesVar(account.colourIndex)}"
                class="bar" ${tip(`${account.name}: ${percentText}. ${currentText}.`)}/>
          ${paceX === null ? '' : `
            <line x1="${paceX.toFixed(1)}" y1="${trackY - 4}" x2="${paceX.toFixed(1)}" y2="${trackY + trackH + 4}"
                  class="pace-marker" ${tip(`Straight line pace says ${formatMoney(progress.pace.expectedPence)} by today`)}/>`}
        </svg>
        <dl class="goal-facts">${facts.join('')}</dl>
      </div>`;
  }).join('');

  return { title: goalsTitle(progressRows), body: blocks };
}

/* ------------------------------------------------------------------ */
/* 5. Contributions                                                    */
/* ------------------------------------------------------------------ */

export function contributionsVisual(ctx) {
  const { state, today, width } = ctx;
  const rows = contributionsByMonth(state, { today, months: 12 });
  const hasAny = rows.some((r) => r.inPence || r.outPence);

  if (!hasAny) {
    return {
      title: contributionsTitle(rows),
      body: emptyChart(width, 140, 'No money in or out yet',
        'Add or withdraw money and the months fill in here.')
    };
  }

  const height = 190;
  const padBottom = 30;
  const padTop = 10;

  // Column axes always start at zero.
  const maxValue = Math.max(1, ...rows.map((r) => Math.max(r.inPence, r.outPence)));
  const scale = niceScale(0, maxValue, 3);
  const padLeft = gutterFor(scale.ticks);
  const plotW = Math.max(40, width - padLeft - 4);
  const plotH = height - padTop - padBottom;
  const y = (v) => padTop + plotH - ((v / (scale.max || 1)) * plotH);

  const slot = plotW / rows.length;
  const barW = Math.max(3, Math.min(14, (slot - 4) / 2));

  const columns = rows.map((row, i) => {
    const centre = padLeft + (i * slot) + (slot / 2);
    const inH = Math.max(row.inPence > 0 ? 1 : 0, padTop + plotH - y(row.inPence));
    const outH = Math.max(row.outPence > 0 ? 1 : 0, padTop + plotH - y(row.outPence));
    const label = `${monthLabel(row.month)} ${row.month.slice(0, 4)}`;
    return `
      <rect x="${(centre - barW - 1).toFixed(1)}" y="${(padTop + plotH - inH).toFixed(1)}"
            width="${barW.toFixed(1)}" height="${inH.toFixed(1)}" rx="1.5"
            fill="var(--positive)" class="bar"
            ${tip(`${label}: ${formatMoney(row.inPence)} in`)}/>
      <rect x="${(centre + 1).toFixed(1)}" y="${(padTop + plotH - outH).toFixed(1)}"
            width="${barW.toFixed(1)}" height="${outH.toFixed(1)}" rx="1.5"
            fill="var(--negative)" class="bar"
            ${tip(`${label}: ${formatMoney(row.outPence)} out`)}/>`;
  }).join('');

  const everyOther = slot < 26;
  const xLabels = rows.map((row, i) => {
    if (everyOther && i % 2 !== rows.length % 2) return '';
    const centre = padLeft + (i * slot) + (slot / 2);
    return `<text x="${centre.toFixed(1)}" y="${height - padBottom + 16}" text-anchor="middle"
      class="axis-label">${esc(monthLabel(row.month))}</text>`;
  }).join('');

  const yLabels = scale.ticks.map((value) => `
    <text x="${padLeft - 6}" y="${(y(value) + 4).toFixed(1)}" text-anchor="end"
          class="axis-label">${esc(axisMoney(value))}</text>`).join('');

  const body = `${svgOpen(width, height, 'Money in against money out for each of the last twelve months')}
      ${yLabels}
      ${columns}
      <line x1="${padLeft}" y1="${padTop + plotH}" x2="${padLeft + plotW}" y2="${padTop + plotH}" class="zero-line"/>
      ${xLabels}
    </svg>
    <ul class="chart-key">
      <li><span class="swatch" style="background:var(--positive)"></span><span class="key-name">Money in</span></li>
      <li><span class="swatch" style="background:var(--negative)"></span><span class="key-name">Money out</span></li>
    </ul>`;

  return { title: contributionsTitle(rows), body };
}

/* ------------------------------------------------------------------ */
/* Optional visuals from the gallery                                   */
/* ------------------------------------------------------------------ */

export function monthlyNetVisual(ctx) {
  const { state, today, width } = ctx;
  const rows = contributionsByMonth(state, { today, months: 12 });
  const hasAny = rows.some((r) => r.inPence || r.outPence);

  if (!hasAny) {
    return {
      title: monthlyNetTitle(rows),
      body: emptyChart(width, 140, 'Nothing saved yet', 'Add money and each month appears here.')
    };
  }

  const height = 180;
  const padTop = 10;
  const padBottom = 30;

  const values = rows.map((r) => r.netPence);
  const scale = niceScale(Math.min(0, ...values), Math.max(0, ...values), 3);
  const padLeft = gutterFor(scale.ticks);
  const plotW = Math.max(40, width - padLeft - 4);
  const plotH = height - padTop - padBottom;
  const span = (scale.max - scale.min) || 1;
  const y = (v) => padTop + plotH - (((v - scale.min) / span) * plotH);
  const zeroY = y(0);

  const slot = plotW / rows.length;
  const barW = Math.max(4, Math.min(20, slot - 6));

  const columns = rows.map((row, i) => {
    const centre = padLeft + (i * slot) + (slot / 2);
    const top = Math.min(zeroY, y(row.netPence));
    const barH = Math.max(1, Math.abs(y(row.netPence) - zeroY));
    return `<rect x="${(centre - barW / 2).toFixed(1)}" y="${top.toFixed(1)}"
      width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="1.5"
      fill="${row.netPence >= 0 ? 'var(--positive)' : 'var(--negative)'}" class="bar"
      ${tip(`${monthLabel(row.month)} ${row.month.slice(0, 4)}: ${formatMoney(row.netPence, { showSign: true })}`)}/>`;
  }).join('');

  const everyOther = slot < 26;
  const xLabels = rows.map((row, i) => {
    if (everyOther && i % 2 !== rows.length % 2) return '';
    const centre = padLeft + (i * slot) + (slot / 2);
    return `<text x="${centre.toFixed(1)}" y="${height - padBottom + 16}" text-anchor="middle"
      class="axis-label">${esc(monthLabel(row.month))}</text>`;
  }).join('');

  const yLabels = scale.ticks.map((value) => `
    <text x="${padLeft - 6}" y="${(y(value) + 4).toFixed(1)}" text-anchor="end"
          class="axis-label">${esc(axisMoney(value))}</text>`).join('');

  return {
    title: monthlyNetTitle(rows),
    body: `${svgOpen(width, height, 'Money left over each month')}
      ${yLabels}${columns}
      <line x1="${padLeft}" y1="${zeroY.toFixed(1)}" x2="${padLeft + plotW}" y2="${zeroY.toFixed(1)}" class="zero-line"/>
      ${xLabels}
    </svg>`
  };
}

export function holdingsVisual(ctx) {
  const { state, today, width } = ctx;
  const balances = balancesAt(state, today);
  const rows = activeAccounts(state)
    .filter((a) => a.type === 'quantity')
    .map((account) => {
      const entry = balances.get(account.id) || { valuePence: 0, unitsE8: 0, pricePence: 0 };
      const age = account.priceUpdatedAt ? daysBetween(account.priceUpdatedAt, today) : null;
      return {
        account,
        valuePence: entry.valuePence,
        unitsE8: entry.unitsE8,
        pricePence: entry.pricePence,
        ageDays: age,
        stale: age === null || age > 7
      };
    })
    .sort((a, b) => b.valuePence - a.valuePence);

  if (!rows.length) {
    return {
      title: holdingsTitle([]),
      body: emptyChart(width, 130, 'No quantity based holdings',
        'Add an account that tracks units and a unit price.')
    };
  }

  const items = rows.map((row) => `
    <li class="holding">
      <span class="swatch" style="background:${seriesVar(row.account.colourIndex)}"></span>
      <span class="holding-name">${esc(row.account.name)}</span>
      <span class="holding-units">${esc(formatUnits(row.unitsE8, 6))} ${esc(row.account.unit || 'units')}</span>
      <span class="holding-price">at ${esc(formatMoney(row.pricePence))}</span>
      <span class="holding-value">${esc(formatMoney(row.valuePence))}</span>
      <span class="holding-age${row.stale ? ' is-stale' : ''}">${esc(
    row.ageDays === null ? 'price never updated'
      : row.ageDays === 0 ? 'updated today'
        : `updated ${row.ageDays} day${row.ageDays === 1 ? '' : 's'} ago`
  )}</span>
    </li>`).join('');

  return { title: holdingsTitle(rows), body: `<ul class="holdings-list">${items}</ul>` };
}

export function categoryTotalsVisual(ctx) {
  const { state, today, width } = ctx;
  const totals = categoryTotals(state, today);
  const rows = CATEGORIES
    .map((name) => ({ name, valuePence: totals[name] || 0 }))
    .filter((r) => r.valuePence !== 0)
    .sort((a, b) => b.valuePence - a.valuePence);

  if (!rows.length) {
    return {
      title: categoryTotalsTitle([]),
      body: emptyChart(width, 130, 'No category totals yet', 'Add money to an account first.')
    };
  }

  const rowHeight = 38;
  const height = rows.length * rowHeight + 8;
  const plotW = width - 2;
  const max = Math.max(...rows.map((r) => r.valuePence));

  const bars = rows.map((row, i) => {
    const top = i * rowHeight + 4;
    const length = Math.max(2, (row.valuePence / max) * plotW);
    return `
      <text x="1" y="${top + 12}" class="bar-name">${esc(row.name)}</text>
      <text x="${plotW}" y="${top + 12}" text-anchor="end" class="bar-value">${esc(formatMoney(row.valuePence))}</text>
      <rect x="1" y="${top + 18}" width="${length.toFixed(1)}" height="12" rx="2"
            fill="${categoryVar(row.name)}" class="bar"
            ${tip(`${row.name}: ${formatMoney(row.valuePence)}`)}/>`;
  }).join('');

  return {
    title: categoryTotalsTitle(rows),
    body: `${svgOpen(width, height, 'Total held in each category, largest first')}${bars}</svg>`
  };
}

/* ------------------------------------------------------------------ */
/* Dispatch                                                            */
/* ------------------------------------------------------------------ */

const RENDERERS = {
  netWorth: netWorthVisual,
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
  const meta = VISUAL_LIBRARY[id] || { name: id, blurb: '' };
  if (!renderer) {
    return { title: meta.name, body: `<p class="chart-error">This visual is not available.</p>`, failed: true };
  }
  try {
    const result = renderer(ctx);
    return { ...result, failed: false };
  } catch (error) {
    return {
      title: meta.name,
      body: `<p class="chart-error">This chart could not be drawn: ${esc(error.message)}. `
        + 'Everything else on the page still works, and your data is untouched.</p>',
      failed: true
    };
  }
}

export { RENDERERS };
