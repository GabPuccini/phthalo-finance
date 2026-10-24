/**
 * plan.js
 *
 * A long term plan, worked out month by month. Pure: no DOM, no storage,
 * no clock. Everything that needs today takes it as an argument.
 *
 * A plan is a set of lines, one per pot of money (an ISA, a loan, a cash
 * pot), each with a starting balance, a growth rate or an interest rate,
 * and monthly amounts that switch on and off by date or by event: when a
 * loan is cleared, or once the house is bought. Money that a line cannot
 * take, because it is full, cleared or closed, moves on to the line named
 * in its redirectTo. A single purchase event buys the house.
 *
 * The same rules run twice: once from the plan's start with the balances
 * written into the plan (the plan you track against), and once from today
 * with your real balances (the forecast). Comparing your accounts with
 * the plan says whether you are ahead or behind; the forecast says where
 * you will end up from here.
 *
 * Money is integer pence throughout, rounded at every step, so the long
 * run cannot drift. Months are "YYYY-MM" keys. The plan's shape, and the
 * checks on it, live in logic.js with the rest of the saved state.
 */

import { balancesAt, sortedTransactions, normalisePlan } from './logic.js';

export const LISA_ANNUAL_LIMIT_PENCE = 400000;   // £4,000 a tax year
export const LISA_BONUS_RATE = 0.25;             // the government adds 25%

/* ------------------------------------------------------------------ */
/* Months                                                              */
/* ------------------------------------------------------------------ */

export function monthIndex(key) {
  const [y, m] = key.split('-').map(Number);
  return (y * 12) + (m - 1);
}

export function monthFromIndex(index) {
  const y = Math.floor(index / 12);
  return `${y}-${String(index - (y * 12) + 1).padStart(2, '0')}`;
}

export function monthOf(dateISO) {
  return dateISO.slice(0, 7);
}

/** UK tax years start on 6 April. At monthly resolution, April opens a new one. */
export function taxYearOf(index) {
  const y = Math.floor(index / 12);
  const m = index - (y * 12) + 1;
  return m >= 4 ? y : y - 1;
}

/** The fixed monthly payment that clears a repayment mortgage over its term. */
export function mortgagePayment(principalPence, ratePct, years) {
  if (!(principalPence > 0)) return 0;
  const n = Math.max(1, Math.round(years * 12));
  const r = (ratePct || 0) / 100 / 12;
  if (r === 0) return Math.ceil(principalPence / n);
  return Math.round((principalPence * r) / (1 - Math.pow(1 + r, -n)));
}

const monthlyGrowth = (pct) => Math.pow(1 + ((pct || 0) / 100), 1 / 12);

/* ------------------------------------------------------------------ */
/* The simulation                                                      */
/* ------------------------------------------------------------------ */

/**
 * Run the plan.
 *
 * options:
 *   startMonth   where to begin, defaults to the plan's own start
 *   untilMonth   stop before this month, defaults to the plan's end
 *   balances     { lineId: pence } to start from, defaults to each line's startPence
 *   clearedAt    { lineId: monthIndex } debts already cleared before the start
 *   purchased    true if the house was already bought before the start
 *   house, mortgage, mortgageMonthlyPence   those, if already bought
 *   purchaseResult, depositReadyIndex   carried over from an earlier run
 *   lisaUsed     { 'lineId:taxYear': pence } allowance already used
 *
 * Every month runs in the same order: growth, then debts, then the monthly
 * amounts, then the purchase. points[k] is the position at the start of
 * month startIndex + k, so the last point is the position the run ends on.
 */
export function simulatePlan(plan, options = {}) {
  const planStart = monthIndex(plan.startMonth);
  const startIndex = options.startMonth ? monthIndex(options.startMonth) : planStart;
  const planEnd = planStart + (plan.years * 12);
  const endIndex = options.untilMonth ? Math.min(planEnd, monthIndex(options.untilMonth)) : planEnd;
  const lines = plan.lines;
  const byId = new Map(lines.map((line) => [line.id, line]));
  const purchase = plan.purchase || null;
  const purchaseIndex = purchase ? monthIndex(purchase.month) : null;

  const balance = new Map();
  for (const line of lines) {
    const given = options.balances && options.balances[line.id];
    balance.set(line.id, Math.round(Number.isFinite(given) ? given : line.startPence));
  }

  const clearedAt = new Map(Object.entries(options.clearedAt || {}));
  for (const line of lines) {
    if (line.kind === 'debt' && balance.get(line.id) <= 0 && !clearedAt.has(line.id)) {
      clearedAt.set(line.id, startIndex - 1);
    }
  }
  const closed = new Set();
  let purchased = Boolean(options.purchased && purchase);
  let house = purchased ? Math.round(options.house || 0) : 0;
  let mortgage = purchased ? Math.round(options.mortgage || 0) : 0;
  let mortgageMonthly = 0;
  if (purchased) {
    mortgageMonthly = Number.isFinite(options.mortgageMonthlyPence)
      ? options.mortgageMonthlyPence
      : mortgagePayment(mortgage, purchase.mortgageRatePct, purchase.mortgageYears);
    if (purchase.lisaLine) closed.add(purchase.lisaLine);
    for (const id of purchase.depositLines) closed.add(id);
  }
  let mortgageClearedAt = null;

  const lisaUsed = new Map(Object.entries(options.lisaUsed || {}));
  const capHits = new Map();
  let lisaBonusPence = 0;
  let unallocatedPence = 0;
  let depositReadyIndex = Number.isFinite(options.depositReadyIndex) ? options.depositReadyIndex : null;
  let purchaseResult = purchased ? (options.purchaseResult || null) : null;

  /* Phases switch on and off by month, by a debt clearing, or by the purchase. */
  const started = (cond, i) => {
    if (!cond) return true;
    if (cond.type === 'month') return i >= monthIndex(cond.month);
    if (cond.type === 'cleared') return clearedAt.has(cond.line) && i > clearedAt.get(cond.line);
    if (cond.type === 'purchase') return purchased;
    return false;
  };
  const notEnded = (cond, i) => {
    if (!cond) return true;
    if (cond.type === 'month') return i <= monthIndex(cond.month);
    if (cond.type === 'cleared') return !clearedAt.has(cond.line) || i <= clearedAt.get(cond.line);
    if (cond.type === 'purchase') return !purchased;
    return true;
  };
  const activePhases = (line, i) => line.phases.filter((p) => started(p.start, i) && notEnded(p.end, i));
  const activeCap = (line, i) => {
    const caps = activePhases(line, i).map((p) => p.capPence).filter((c) => Number.isFinite(c));
    return caps.length ? Math.min(...caps) : null;
  };
  const noteCap = (line, cap, i) => {
    const key = `${line.id}:${cap}`;
    if (!capHits.has(key)) capHits.set(key, { lineId: line.id, capPence: cap, index: i });
  };

  // A pot that starts the run already full reached its cap before the run began.
  for (const line of lines) {
    if (line.kind !== 'asset' || closed.has(line.id)) continue;
    const cap = activeCap(line, startIndex);
    if (cap !== null && balance.get(line.id) >= cap) noteCap(line, cap, startIndex - 1);
  }

  function redirect(line, amount, i, depth) {
    if (amount <= 0) return;
    if (line.redirectTo && depth < 8) deposit(line.redirectTo, amount, i, depth + 1);
    else unallocatedPence += amount;
  }

  /** Pay money into a line, honouring the Lifetime ISA limit and any cap. */
  function deposit(lineId, amount, i, depth = 0) {
    if (amount <= 0) return;
    const line = byId.get(lineId);
    if (!line) { unallocatedPence += amount; return; }
    if (closed.has(lineId) || line.kind === 'debt') { redirect(line, amount, i, depth); return; }

    let allowed = amount;
    const taxKey = `${lineId}:${taxYearOf(i)}`;
    if (line.lisa) {
      allowed = Math.min(allowed, Math.max(0, LISA_ANNUAL_LIMIT_PENCE - (lisaUsed.get(taxKey) || 0)));
    }
    const cap = activeCap(line, i);
    if (cap !== null) allowed = Math.min(allowed, Math.max(0, cap - balance.get(lineId)));

    if (allowed > 0) {
      let added = allowed;
      if (line.lisa) {
        lisaUsed.set(taxKey, (lisaUsed.get(taxKey) || 0) + allowed);
        const bonus = Math.round(allowed * LISA_BONUS_RATE);
        lisaBonusPence += bonus;
        added += bonus;
      }
      balance.set(lineId, balance.get(lineId) + added);
    }
    if (cap !== null && balance.get(lineId) >= cap) noteCap(line, cap, i);
    redirect(line, amount - allowed, i, depth);
  }

  /** Cash in the deposit pots, and whether it covers the costs and the deposit. */
  function readiness() {
    const cash = purchase.depositLines.reduce((sum, id) => sum + (balance.get(id) || 0), 0);
    const lisa = purchase.lisaLine ? Math.max(0, balance.get(purchase.lisaLine) || 0) : 0;
    const minDeposit = Math.round((purchase.pricePence * purchase.minDepositPct) / 100);
    return cash >= purchase.costsPence + Math.max(0, minDeposit - lisa);
  }

  function runPurchase(i) {
    const price = purchase.pricePence;
    const minDeposit = Math.round((price * purchase.minDepositPct) / 100);
    const empty = (id) => {
      const have = balance.get(id) || 0;
      balance.set(id, 0);
      return have;
    };

    // A Lifetime ISA can only go toward the price, so all of it does.
    const lisaPence = purchase.lisaLine ? Math.min(price, Math.max(0, empty(purchase.lisaLine))) : 0;
    if (purchase.lisaLine) closed.add(purchase.lisaLine);

    // The deposit pots are emptied and closed. Their cash tops the deposit
    // up to the lender's minimum first, then pays the buying costs.
    let cashPence = 0;
    for (const id of purchase.depositLines) {
      cashPence += empty(id);
      closed.add(id);
    }
    let cash = Math.max(0, cashPence);
    const topUpWanted = Math.max(0, minDeposit - lisaPence);
    let topUpPence = Math.min(cash, topUpWanted);
    cash -= topUpPence;
    const costsFromPots = Math.min(cash, purchase.costsPence);
    cash -= costsFromPots;
    let costsLeft = purchase.costsPence - costsFromPots;

    // What the pots do not need moves on. What they cannot cover comes out
    // of that same line, the savings, and anything beyond its balance still
    // has to be paid, so the line goes below zero: borrowed money, which
    // keeps the net worth honest.
    const to = purchase.leftoverTo && byId.has(purchase.leftoverTo) ? purchase.leftoverTo : null;
    let fromSavingsPence = 0;
    let costsShortPence = 0;
    if (to) {
      balance.set(to, balance.get(to) + cash);
      let available = Math.max(0, balance.get(to));
      const moreTopUp = Math.min(available, topUpWanted - topUpPence);
      topUpPence += moreTopUp;
      available -= moreTopUp;
      const moreCosts = Math.min(available, costsLeft);
      costsLeft -= moreCosts;
      fromSavingsPence = moreTopUp + moreCosts;
      costsShortPence = costsLeft;
      balance.set(to, balance.get(to) - fromSavingsPence - costsShortPence);
    } else {
      unallocatedPence += cash;
      costsShortPence = costsLeft;
    }

    const depositPence = lisaPence + topUpPence;
    house = price;
    mortgage = Math.max(0, price - depositPence);
    mortgageMonthly = mortgagePayment(mortgage, purchase.mortgageRatePct, purchase.mortgageYears);
    purchased = true;
    purchaseResult = {
      index: i,
      month: monthFromIndex(i),
      pricePence: price,
      minDepositPence: minDeposit,
      lisaPence,
      topUpPence,
      depositPence,
      depositPct: price > 0 ? (depositPence / price) * 100 : 0,
      mortgagePence: mortgage,
      loanToValuePct: price > 0 ? (mortgage / price) * 100 : 0,
      monthlyPaymentPence: mortgageMonthly,
      overpaymentPence: purchase.overpaymentPence,
      costsPence: purchase.costsPence,
      cashPence,
      leftoverPence: to ? cash : 0,
      leftoverTo: to,
      fromSavingsPence,
      costsShortPence,
      depositShortPence: Math.max(0, minDeposit - depositPence)
    };
  }

  function snapshot(index) {
    const values = {};
    let assets = 0;
    let debts = 0;
    for (const line of lines) {
      const v = balance.get(line.id);
      values[line.id] = v;
      if (line.kind === 'debt') debts += Math.max(0, v);
      else assets += v;
    }
    if (purchase) {
      values.house = house;
      values.mortgage = mortgage;
      assets += house;
      debts += mortgage;
    }
    return { index, month: monthFromIndex(index), values, assetsPence: assets, debtsPence: debts, netWorthPence: assets - debts };
  }

  const points = [snapshot(startIndex)];
  for (let i = startIndex; i < endIndex; i += 1) {
    // 1. Growth, at a steady monthly rate.
    for (const line of lines) {
      if (line.kind !== 'asset' || !line.growthPct || closed.has(line.id)) continue;
      const v = balance.get(line.id);
      if (v > 0) balance.set(line.id, Math.round(v * monthlyGrowth(line.growthPct)));
    }
    if (purchased && house > 0) house = Math.round(house * monthlyGrowth(purchase.houseGrowthPct));

    // 2. Debts: a month of interest, then the scheduled payment.
    for (const line of lines) {
      if (line.kind !== 'debt') continue;
      if (clearedAt.has(line.id)) {
        // Cleared: the payment that used to go here moves on.
        if (i > clearedAt.get(line.id)) redirect(line, line.paymentPence, i, 0);
        continue;
      }
      const owed = balance.get(line.id);
      const withInterest = owed + Math.round((owed * line.aprPct) / 100 / 12);
      const paid = Math.min(line.paymentPence, withInterest);
      balance.set(line.id, withInterest - paid);
      if (withInterest - paid <= 0) {
        balance.set(line.id, 0);
        clearedAt.set(line.id, i);
        redirect(line, line.paymentPence - paid, i, 0);
      }
    }
    if (purchased && mortgage > 0) {
      const withInterest = mortgage + Math.round((mortgage * purchase.mortgageRatePct) / 100 / 12);
      const paid = Math.min(mortgageMonthly + purchase.overpaymentPence, withInterest);
      mortgage = withInterest - paid;
      if (mortgage <= 0) { mortgage = 0; mortgageClearedAt = i; }
    }

    // 3. Monthly amounts, in the order the lines are listed.
    for (const line of lines) {
      if (line.kind === 'debt') continue;
      for (const phase of activePhases(line, i)) deposit(line.id, phase.amountPence, i);
    }

    // 4. Is the deposit there yet? Then, in its month, buy the house.
    if (purchase && !purchased) {
      if (depositReadyIndex === null && readiness()) depositReadyIndex = i;
      if (i === purchaseIndex) runPurchase(i);
    }

    points.push(snapshot(i + 1));
  }

  return {
    points,
    startIndex,
    endIndex,
    clearedAt: Object.fromEntries(clearedAt),
    mortgageClearedAt,
    capHits: Array.from(capHits.values()),
    depositReadyIndex,
    purchase: purchaseResult,
    lisaBonusPence,
    unallocatedPence,
    lisaUsed: Object.fromEntries(lisaUsed)
  };
}

/* ------------------------------------------------------------------ */
/* Reading a run                                                       */
/* ------------------------------------------------------------------ */

/** The run's position at the start of a month, or null outside it. */
export function pointAt(run, month) {
  const k = monthIndex(month) - run.startIndex;
  return k >= 0 && k < run.points.length ? run.points[k] : null;
}

/** Position on a date, between the two month starts either side of it. */
export function valueOnDate(run, dateISO, pick = (p) => p.netWorthPence) {
  const k = monthIndex(monthOf(dateISO)) - run.startIndex;
  if (k < 0) return pick(run.points[0]);
  if (k >= run.points.length - 1) return pick(run.points[run.points.length - 1]);
  const day = Number(dateISO.slice(8, 10));
  const fraction = Math.min(1, (day - 1) / 30);
  const a = pick(run.points[k]);
  const b = pick(run.points[k + 1]);
  return Math.round(a + ((b - a) * fraction));
}

/** The position at the end of each plan year that the run covers. */
export function yearlyCheckpoints(plan, run) {
  const rows = [];
  const planStart = monthIndex(plan.startMonth);
  for (let year = 1; year <= plan.years; year += 1) {
    const point = pointAt(run, monthFromIndex(planStart + (year * 12)));
    if (point) rows.push({ year, ...point });
  }
  return rows;
}

/**
 * The milestones a run reaches. Each carries the month it happens in, as a
 * month index, or null when it does not happen within the plan.
 */
export function planMilestones(plan, run) {
  const out = [];
  const first = run.points[0];
  if (first.netWorthPence < 0 || run.startIndex > monthIndex(plan.startMonth)) {
    const k = run.points.findIndex((p) => p.netWorthPence >= 0);
    out.push({
      key: 'positive',
      title: 'Net worth above zero',
      index: k === -1 ? null : run.points[k].index - 1
    });
  }
  for (const line of plan.lines.filter((l) => l.kind === 'debt')) {
    const at = run.clearedAt[line.id];
    out.push({ key: `cleared:${line.id}`, title: `${line.name} paid off`, index: Number.isFinite(at) ? at : null });
  }
  for (const line of plan.lines) {
    for (const cap of [...new Set(line.phases.map((p) => p.capPence).filter(Number.isFinite))]) {
      const hit = run.capHits.find((h) => h.lineId === line.id && h.capPence === cap);
      out.push({ key: `full:${line.id}:${cap}`, title: `${line.name} reaches ${poundsWhole(cap)}`, index: hit ? hit.index : null });
    }
  }
  if (plan.purchase) {
    out.push({ key: 'deposit', title: 'Deposit and buying costs saved', index: run.depositReadyIndex });
    out.push({ key: 'purchase', title: 'House bought', index: run.purchase ? run.purchase.index : null, purchase: run.purchase });
  }
  return out.sort((a, b) => (a.index === null) - (b.index === null) || (a.index - b.index));
}

function poundsWhole(pence) {
  return `£${Math.round(pence / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

/* ------------------------------------------------------------------ */
/* The plan against your real accounts                                 */
/* ------------------------------------------------------------------ */

/** Every key a plan's values carry: its lines, then the house and mortgage. */
export function planKeys(plan) {
  return [...plan.lines.map((l) => l.id), ...(plan.purchase ? ['house', 'mortgage'] : [])];
}

/** The display name of a key. */
export function keyName(plan, key) {
  if (key === 'house') return 'House';
  if (key === 'mortgage') return 'Mortgage';
  const line = plan.lines.find((l) => l.id === key);
  return line ? line.name : key;
}

const isDebtKey = (plan, key) => key === 'mortgage' || (plan.lines.find((l) => l.id === key) || {}).kind === 'debt';

/**
 * Which live accounts each key is linked to, and the date of the first
 * entry on any of them. A key with linked accounts but nothing recorded
 * yet is not compared: an empty loan account would otherwise read as a
 * loan paid off.
 */
export function planLinks(plan, state) {
  const live = new Set(state.accounts.filter((a) => !a.archived).map((a) => a.id));
  const first = new Map();
  for (const tx of sortedTransactions(state)) {
    if (!first.has(tx.accountId)) first.set(tx.accountId, tx.date);
  }
  const accountIdsFor = (key) => {
    if (key === 'house') return plan.purchase.houseAccountIds;
    if (key === 'mortgage') return plan.purchase.mortgageAccountIds;
    return plan.lines.find((l) => l.id === key).accountIds;
  };
  const out = {};
  for (const key of planKeys(plan)) {
    const accountIds = accountIdsFor(key).filter((id) => live.has(id));
    const dates = accountIds.map((id) => first.get(id)).filter(Boolean).sort();
    out[key] = { accountIds, firstDate: dates.length ? dates[0] : null };
  }
  return out;
}

/** Real balance of each key's linked accounts on a date, or null when there is nothing to compare. */
export function linkedActuals(plan, state, dateISO, links = planLinks(plan, state)) {
  const balances = balancesAt(state, dateISO);
  const out = {};
  for (const [key, link] of Object.entries(links)) {
    if (!link.accountIds.length || !link.firstDate || link.firstDate > dateISO) { out[key] = null; continue; }
    out[key] = link.accountIds.reduce((total, id) => total + ((balances.get(id) || { valuePence: 0 }).valuePence), 0);
  }
  return out;
}

/** Assets less debts over a set of keys. */
function totalOf(plan, values, keys) {
  let total = 0;
  for (const key of keys) {
    const v = values[key] || 0;
    total += isDebtKey(plan, key) ? -Math.max(0, v) : v;
  }
  return total;
}

/** Your position in the plan's terms: real balances where linked, the plan's figure elsewhere. */
function blended(plan, actual, planValues) {
  const values = {};
  for (const key of planKeys(plan)) values[key] = actual[key] !== null && actual[key] !== undefined ? actual[key] : (planValues[key] || 0);
  return totalOf(plan, values, planKeys(plan));
}

/**
 * Everything the Plan screen needs, worked out in one go.
 */
export function planStatus(plan, state, todayISO) {
  const baseline = simulatePlan(plan);
  const nowIndex = monthIndex(monthOf(todayISO));
  const planStart = monthIndex(plan.startMonth);
  const planEnd = planStart + (plan.years * 12);
  const links = planLinks(plan, state);
  const actual = linkedActuals(plan, state, todayISO, links);
  const keys = planKeys(plan);
  const linkedKeys = keys.filter((k) => actual[k] !== null);
  const unlinked = keys.filter((k) => !links[k].accountIds.length);
  const unrecorded = keys.filter((k) => links[k].accountIds.length && actual[k] === null);
  const planValuesToday = {};
  for (const key of keys) planValuesToday[key] = valueOnDate(baseline, todayISO, (p) => p.values[key] || 0);

  // Forecast: the same rules from next month, starting from today's real
  // balances, as if this month's amounts are already in.
  const forecastStart = nowIndex + 1;
  let forecast = null;
  if (nowIndex >= planStart && forecastStart < planEnd) {
    const next = pointAt(baseline, monthFromIndex(forecastStart));
    const balances = {};
    for (const line of plan.lines) {
      balances[line.id] = actual[line.id] !== null
        ? (line.kind === 'debt' ? Math.max(0, actual[line.id]) : actual[line.id])
        : next.values[line.id];
    }
    const clearedAt = {};
    for (const line of plan.lines.filter((l) => l.kind === 'debt')) {
      const planned = Number.isFinite(baseline.clearedAt[line.id]) ? baseline.clearedAt[line.id] : Infinity;
      if (actual[line.id] !== null && actual[line.id] <= 0) clearedAt[line.id] = Math.min(nowIndex, planned);
      else if (actual[line.id] === null && planned < forecastStart) clearedAt[line.id] = planned;
    }
    const purchased = Boolean(plan.purchase) && monthIndex(plan.purchase.month) < forecastStart;
    const lisaUsed = {};
    if (taxYearOf(forecastStart) === taxYearOf(nowIndex)) {
      const soFar = simulatePlan(plan, { untilMonth: monthFromIndex(forecastStart) }).lisaUsed;
      for (const [key, used] of Object.entries(soFar)) {
        if (Number(key.slice(key.lastIndexOf(':') + 1)) === taxYearOf(forecastStart)) lisaUsed[key] = used;
      }
    }
    const fromActual = (key) => (actual[key] !== null && actual[key] !== undefined ? actual[key] : next.values[key]);
    forecast = simulatePlan(plan, {
      startMonth: monthFromIndex(forecastStart),
      balances,
      clearedAt,
      purchased,
      house: purchased ? fromActual('house') : 0,
      mortgage: purchased ? fromActual('mortgage') : 0,
      mortgageMonthlyPence: baseline.purchase ? baseline.purchase.monthlyPaymentPence : undefined,
      purchaseResult: purchased ? baseline.purchase : null,
      depositReadyIndex: purchased ? baseline.depositReadyIndex : null,
      lisaUsed
    });
  }

  // Ahead or behind: linked accounts today against the plan for the same lines.
  const actualPence = totalOf(plan, actual, linkedKeys);
  const planPence = totalOf(plan, planValuesToday, linkedKeys);
  const differencePence = actualPence - planPence;
  const tolerancePence = Math.max(5000, Math.round(Math.abs(planPence) * 0.01));
  let status = 'on plan';
  if (nowIndex < planStart) status = 'not started';
  else if (!linkedKeys.length) status = 'not linked';
  else if (differencePence > tolerancePence) status = 'ahead';
  else if (differencePence < -tolerancePence) status = 'behind';

  const perLine = keys.map((key) => ({
    key,
    name: keyName(plan, key),
    debt: isDebtKey(plan, key),
    linked: links[key].accountIds.length > 0,
    actualPence: actual[key],
    planPence: planValuesToday[key]
  }));

  // Accounts holding money that the plan does not track.
  const linkedIds = new Set(Object.values(links).flatMap((l) => l.accountIds));
  const balances = balancesAt(state, todayISO);
  const outside = state.accounts
    .filter((a) => !a.archived && !linkedIds.has(a.id))
    .map((a) => ({ id: a.id, name: a.name, debt: a.type === 'liability', valuePence: (balances.get(a.id) || { valuePence: 0 }).valuePence }))
    .filter((a) => a.valuePence !== 0);

  const forecastMilestones = forecast ? planMilestones(plan, forecast) : [];
  const milestones = planMilestones(plan, baseline).map((m) => {
    const f = forecastMilestones.find((x) => x.key === m.key);
    return {
      key: m.key,
      title: m.title,
      planIndex: m.index,
      forecastIndex: f ? f.index : m.index,
      done: f ? f.index !== null && f.index <= nowIndex : m.index !== null && m.index <= nowIndex,
      planPurchase: m.purchase || null,
      forecastPurchase: f ? f.purchase || null : m.purchase || null
    };
  });

  return {
    baseline,
    forecast,
    milestones,
    nowIndex,
    today: {
      actualPence,
      planPence,
      differencePence,
      status,
      tolerancePence,
      planNetWorthPence: valueOnDate(baseline, todayISO),
      youNetWorthPence: blended(plan, actual, planValuesToday)
    },
    perLine,
    linkedKeys,
    unlinked,
    unrecorded,
    outside
  };
}

/**
 * The three lines on the plan chart, each a list of { date, valuePence }:
 * the plan from its start, where you have been at each month start up to
 * today (real balances where linked, the plan's figure for the rest), and
 * the forecast from today to the plan's end.
 */
export function planSeries(plan, state, todayISO, status = planStatus(plan, state, todayISO)) {
  const baseline = status.baseline;
  const planned = baseline.points.map((p) => ({ date: `${p.month}-01`, valuePence: p.netWorthPence }));
  const you = [];
  const forecast = [];
  const planStart = monthIndex(plan.startMonth);
  if (status.linkedKeys.length && status.nowIndex >= planStart) {
    const links = planLinks(plan, state);
    const lastFull = Math.min(status.nowIndex, baseline.endIndex);
    for (let i = planStart; i <= lastFull; i += 1) {
      const date = `${monthFromIndex(i)}-01`;
      if (date > todayISO) break;
      const actual = linkedActuals(plan, state, date, links);
      you.push({ date, valuePence: blended(plan, actual, baseline.points[i - planStart].values) });
    }
    // Today only belongs on the chart while the plan is still running.
    if (status.nowIndex < baseline.endIndex && (!you.length || you[you.length - 1].date !== todayISO)) {
      you.push({ date: todayISO, valuePence: status.today.youNetWorthPence });
    }
    if (status.forecast) {
      forecast.push({ date: todayISO, valuePence: status.today.youNetWorthPence });
      for (const p of status.forecast.points) forecast.push({ date: `${p.month}-01`, valuePence: p.netWorthPence });
    }
  }
  return { planned, you, forecast };
}

/* ------------------------------------------------------------------ */
/* The house plan, as worked out in conversation                       */
/* ------------------------------------------------------------------ */

/**
 * The ten year plan to a house in Greater Manchester, from April 2026.
 *
 * The figures are the ones agreed, with one deliberate correction: the
 * loan uses its real schedule, £188 a month at 14% APR, which clears it
 * in early 2032 rather than the March 2030 the written plan assumed.
 * Every number is editable on the Plan tab.
 *
 * Lines are linked to accounts by id where the defaults exist, otherwise
 * by name or category, so it fits an app whose accounts were renamed.
 */
export function housePlan(accounts = []) {
  const live = accounts.filter((a) => !a.archived);
  const byId = (id) => (live.some((a) => a.id === id) ? [id] : []);
  const byName = (re, extra = () => true) => live.filter((a) => re.test(a.name) && extra(a)).map((a) => a.id);
  const pick = (id, re, extra) => (byId(id).length ? byId(id) : byName(re, extra).slice(0, 1));
  const crypto = live.filter((a) => a.category === 'Crypto').map((a) => a.id);
  const debt = byId('acc_debt').length ? ['acc_debt'] : live.filter((a) => a.type === 'liability' && !/mortgage/i.test(a.name)).map((a) => a.id).slice(0, 1);
  const month = (m) => ({ type: 'month', month: m });

  return normalisePlan({
    name: 'House by 2031',
    startMonth: '2026-04',
    years: 10,
    notes: 'Flat £26k income throughout. Stocks and Shares ISA, Lifetime ISA and pension grow at 5% a year after inflation; '
      + 'crypto, gold, silver and cash are held flat. The house grows at 4% a year after purchase. '
      + 'Paying into the Lifetime ISA after April 2028 assumes the existing account stays open to new money: check that with AJ Bell.',
    lines: [
      { id: 'ssisa', name: 'Stocks and Shares ISA', kind: 'asset', accountIds: pick('acc_ssisa', /stocks|s&s/i),
        startPence: 210000, growthPct: 5,
        phases: [{ id: 'invest', amountPence: 40000, start: month('2032-04') }] },
      { id: 'lisa', name: 'Lifetime ISA', kind: 'asset', accountIds: pick('acc_lisa', /lifetime|lisa/i),
        startPence: 0, growthPct: 5, lisa: true, redirectTo: 'deposit',
        phases: [
          { id: 'y1', amountPence: 20000, end: month('2027-03') },
          { id: 'y2', amountPence: 30000, start: month('2027-04'), end: month('2028-03') },
          { id: 'max', amountPence: 33333, start: month('2028-04'), end: { type: 'purchase' } }
        ] },
      { id: 'crypto', name: 'Crypto', kind: 'asset', accountIds: crypto, startPence: 68000, growthPct: 0, phases: [] },
      { id: 'gold', name: 'Gold', kind: 'asset', accountIds: pick('acc_gold', /gold/i), startPence: 30000, growthPct: 0, phases: [] },
      { id: 'silver', name: 'Silver', kind: 'asset', accountIds: pick('acc_silver', /silver/i), startPence: 10000, growthPct: 0, phases: [] },
      { id: 'savings', name: 'Savings and emergency fund', kind: 'asset', accountIds: pick('acc_savings', /saving|emergency/i),
        startPence: 120000, growthPct: 0, redirectTo: 'deposit',
        phases: [
          { id: 'y1', amountPence: 10000, capPence: 450000, end: month('2027-03') },
          { id: 'build', amountPence: 6000, capPence: 450000, start: month('2027-04'), end: { type: 'purchase' } },
          { id: 'rebuild', amountPence: 20000, capPence: 1000000, start: { type: 'purchase' } }
        ] },
      { id: 'deposit', name: 'House deposit pot', kind: 'asset', accountIds: byName(/deposit/i),
        startPence: 0, growthPct: 0, redirectTo: 'ssisa', phases: [] },
      { id: 'loan', name: 'Personal loan', kind: 'debt', accountIds: debt,
        startPence: 903100, aprPct: 14, paymentPence: 18800, redirectTo: 'deposit', phases: [] },
      { id: 'pension', name: 'Workplace pension', kind: 'asset', accountIds: byName(/pension/i),
        startPence: 0, growthPct: 5, phases: [{ id: 'match', amountPence: 19000, start: month('2032-04') }] },
      { id: 'business', name: 'ronaldostats.app', kind: 'asset', accountIds: byName(/business|ronaldo/i),
        startPence: 0, growthPct: 0, phases: [{ id: 'build', amountPence: 12500, start: month('2032-04') }] }
    ],
    purchase: {
      month: '2031-10',
      pricePence: 17000000,
      minDepositPct: 10,
      // Conveyancing £1,500, survey £750, mortgage fee £1,000, furnishing £2,500, removals £600, buffer £750.
      costsPence: 710000,
      mortgageRatePct: 5,
      mortgageYears: 30,
      overpaymentPence: 20000,
      houseGrowthPct: 4,
      lisaLine: 'lisa',
      depositLines: ['deposit'],
      leftoverTo: 'savings',
      houseAccountIds: byName(/house|home|property/i, (a) => a.type !== 'liability'),
      mortgageAccountIds: byName(/mortgage/i)
    }
  }, new Set(live.map((a) => a.id)));
}
