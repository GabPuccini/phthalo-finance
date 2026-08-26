/**
 * cases.js
 *
 * The assertions themselves, kept separate from the runner so that the
 * Node test runner and the in browser test page run exactly the same
 * checks rather than two copies that can drift apart.
 *
 *   node --test          runs them through tests/logic.test.js
 *   tests.html           runs them in the browser, on the phone
 *
 * Every case uses a fixed "today" so results never change with the clock.
 */

import * as L from '../src/logic.js';

/** Set by whichever runner is in charge before the cases run. */
let assert;
export function useAssert(implementation) { assert = implementation; }

export const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

const TODAY = '2026-08-26';

/* ------------------------------------------------------------------ */
/* Builders                                                            */
/* ------------------------------------------------------------------ */

let sequence = 0;
function tx(accountId, date, direction, pounds, extra = {}) {
  sequence += 1;
  return {
    id: `tx_${sequence}`,
    accountId,
    date,
    direction,
    amountPence: Math.round(pounds * 100),
    unitsE8: 0,
    unitPricePence: null,
    note: '',
    createdAt: `${date}T00:00:0${sequence % 10}.000Z`,
    ...extra
  };
}

function account(id, name, type, category, extra = {}) {
  return {
    id,
    name,
    type,
    category,
    order: 0,
    colourIndex: 5,
    archived: false,
    goal: null,
    note: '',
    ...extra
  };
}

function makeState(accounts, transactions) {
  return L.normaliseState(
    { accounts, transactions, schemaVersion: L.SCHEMA_VERSION },
    TODAY
  );
}

/* ------------------------------------------------------------------ */
/* Net worth                                                           */
/* ------------------------------------------------------------------ */

test('net worth mixes assets and debt', () => {
  const state = makeState(
    [
      account('savings', 'Savings account', 'balance', 'Cash', { order: 0 }),
      account('isa', 'Stocks and Shares ISA', 'balance', 'Investments', { order: 1 }),
      account('debt', 'Debt', 'liability', 'Debt', { order: 2 })
    ],
    [
      tx('savings', '2026-01-10', 'in', 5000),
      tx('isa', '2026-01-10', 'in', 3000),
      tx('debt', '2026-01-10', 'in', 2000)
    ]
  );
  const nw = L.netWorthAt(state, TODAY);
  assert.equal(nw.assetsPence, 800000);
  assert.equal(nw.liabilitiesPence, 200000);
  assert.equal(nw.netWorthPence, 600000);
});

test('net worth can be negative when debt outweighs assets', () => {
  const state = makeState(
    [
      account('current', 'Current account', 'balance', 'Cash', { order: 0 }),
      account('debt', 'Debt', 'liability', 'Debt', { order: 1 })
    ],
    [
      tx('current', '2026-02-01', 'in', 250.5),
      tx('debt', '2026-02-01', 'in', 4000)
    ]
  );
  const nw = L.netWorthAt(state, TODAY);
  assert.equal(nw.netWorthPence, 25050 - 400000);
  assert.equal(nw.netWorthPence, -374950);
  assert.equal(L.formatMoney(nw.netWorthPence), '-£3,749.50');
});

test('adding then withdrawing returns to exactly the starting balance', () => {
  // 0.1 + 0.2 is the classic floating point trap. In pence it is exact.
  const state = makeState(
    [account('savings', 'Savings account', 'balance', 'Cash')],
    [
      tx('savings', '2026-01-01', 'in', 1000),
      tx('savings', '2026-01-02', 'in', 0.1),
      tx('savings', '2026-01-03', 'in', 0.2),
      tx('savings', '2026-01-04', 'out', 0.3),
      tx('savings', '2026-01-05', 'in', 19.99),
      tx('savings', '2026-01-06', 'out', 19.99)
    ]
  );
  const balances = L.balancesAt(state, TODAY);
  assert.equal(balances.get('savings').valuePence, 100000);
  assert.equal(L.formatMoney(balances.get('savings').valuePence), '£1,000.00');
});

test('a thousand small round trips leave no drift at all', () => {
  const entries = [];
  for (let i = 0; i < 1000; i += 1) {
    entries.push(tx('savings', '2026-03-01', 'in', 0.01));
    entries.push(tx('savings', '2026-03-02', 'out', 0.01));
  }
  const state = makeState([account('savings', 'Savings', 'balance', 'Cash')], entries);
  assert.equal(L.balancesAt(state, TODAY).get('savings').valuePence, 0);
});

/* ------------------------------------------------------------------ */
/* Daily series and backdating                                         */
/* ------------------------------------------------------------------ */

test('a backdated transaction slots into the right place in the daily series', () => {
  const accounts = [account('savings', 'Savings account', 'balance', 'Cash')];
  const before = makeState(accounts, [
    tx('savings', '2026-01-01', 'in', 100),
    tx('savings', '2026-01-05', 'in', 100)
  ]);
  const seriesBefore = L.buildDailySeries(before, { today: '2026-01-05' });
  assert.equal(seriesBefore.length, 5);
  assert.deepEqual(
    seriesBefore.map((p) => p.netWorthPence),
    [10000, 10000, 10000, 10000, 20000]
  );

  // Insert an entry dated between the two existing ones.
  const after = makeState(accounts, [
    ...before.transactions,
    tx('savings', '2026-01-03', 'in', 50)
  ]);
  const seriesAfter = L.buildDailySeries(after, { today: '2026-01-05' });
  assert.deepEqual(
    seriesAfter.map((p) => p.netWorthPence),
    [10000, 10000, 15000, 15000, 25000],
    'the backdated entry must lift the line from the 3rd onwards, not from today'
  );
  assert.deepEqual(seriesAfter.map((p) => p.date), [
    '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05'
  ]);
});

test('a backdated transaction is still correct when entered out of order', () => {
  // Same three entries, supplied to the state in a scrambled order.
  const accounts = [account('savings', 'Savings account', 'balance', 'Cash')];
  const scrambled = makeState(accounts, [
    tx('savings', '2026-01-05', 'in', 100),
    tx('savings', '2026-01-01', 'in', 100),
    tx('savings', '2026-01-03', 'in', 50)
  ]);
  const series = L.buildDailySeries(scrambled, { today: '2026-01-05' });
  assert.deepEqual(series.map((p) => p.netWorthPence), [10000, 10000, 15000, 15000, 25000]);
});

test('editing an old transaction rewrites the whole history after it', () => {
  const accounts = [account('savings', 'Savings account', 'balance', 'Cash')];
  const original = makeState(accounts, [
    tx('savings', '2026-01-01', 'in', 100),
    tx('savings', '2026-01-03', 'in', 50),
    tx('savings', '2026-01-05', 'in', 100)
  ]);
  const firstId = L.sortedTransactions(original)[0].id;

  // Change the very first entry from 100 to 400.
  const edited = makeState(
    accounts,
    original.transactions.map((t) => (t.id === firstId ? { ...t, amountPence: 40000 } : t))
  );
  const series = L.buildDailySeries(edited, { today: '2026-01-05' });
  assert.deepEqual(
    series.map((p) => p.netWorthPence),
    [40000, 40000, 45000, 45000, 55000],
    'every day from the edited entry onwards must move, not just today'
  );

  // Moving that same entry to a later date must also rewrite the line.
  const moved = makeState(
    accounts,
    original.transactions.map((t) => (t.id === firstId ? { ...t, date: '2026-01-04' } : t))
  );
  assert.deepEqual(
    L.buildDailySeries(moved, { today: '2026-01-05' }).map((p) => p.netWorthPence),
    [5000, 15000, 25000],
    'moving the first entry later also moves the start of the series'
  );
});

test('deleting a transaction removes its effect from every earlier day too', () => {
  const accounts = [account('savings', 'Savings account', 'balance', 'Cash')];
  const state = makeState(accounts, [
    tx('savings', '2026-01-01', 'in', 100),
    tx('savings', '2026-01-03', 'in', 50)
  ]);
  const middle = L.sortedTransactions(state)[1].id;
  const pruned = makeState(accounts, state.transactions.filter((t) => t.id !== middle));
  assert.deepEqual(
    L.buildDailySeries(pruned, { today: '2026-01-04' }).map((p) => p.netWorthPence),
    [10000, 10000, 10000, 10000]
  );
});

test('the daily series covers a requested window even with no transactions in it', () => {
  const state = makeState([account('savings', 'Savings', 'balance', 'Cash')], []);
  const series = L.buildDailySeries(state, { today: '2026-01-03', fromDate: '2026-01-01' });
  assert.equal(series.length, 3);
  assert.ok(series.every((p) => p.netWorthPence === 0));
});

/* ------------------------------------------------------------------ */
/* Quantity holdings                                                   */
/* ------------------------------------------------------------------ */

test('quantity value is exact and handles a zero or missing price', () => {
  assert.equal(L.quantityValuePence(L.UNIT_SCALE, 5000000), 5000000); // 1 unit at 50,000
  assert.equal(L.quantityValuePence(L.UNIT_SCALE / 2, 5000000), 2500000); // half a unit
  assert.equal(L.quantityValuePence(L.UNIT_SCALE, 0), 0, 'a zero price is worth nothing');
  assert.equal(L.quantityValuePence(L.UNIT_SCALE, undefined), 0, 'a missing price is worth nothing');
  assert.equal(L.quantityValuePence(0, 5000000), 0, 'holding nothing is worth nothing');
  assert.equal(L.quantityValuePence(NaN, 5000000), 0);
});

test('a large holding does not drift by a penny', () => {
  // 15 BTC at 60,000 pounds. The naive multiplication loses precision here.
  const units = 15 * L.UNIT_SCALE;
  const price = 6000000; // 60,000 pounds in pence
  assert.equal(L.quantityValuePence(units, price), 90000000); // 900,000 pounds
  assert.equal(L.formatMoney(L.quantityValuePence(units, price)), '£900,000.00');
});

test('a quantity account with no price set still reports a zero value, not a crash', () => {
  const state = makeState(
    [account('btc', 'Bitcoin', 'quantity', 'Crypto', { unit: 'BTC', unitPricePence: 0 })],
    [tx('btc', '2026-01-01', 'in', 1000, { unitsE8: L.UNIT_SCALE / 10, unitPricePence: null })]
  );
  const balance = L.balancesAt(state, TODAY).get('btc');
  assert.equal(balance.unitsE8, L.UNIT_SCALE / 10);
  assert.equal(balance.valuePence, 0);
});

test('historic value uses the price recorded at the time, not today price', () => {
  const state = makeState(
    [account('btc', 'Bitcoin', 'quantity', 'Crypto', {
      unit: 'BTC', unitPricePence: 8000000, priceUpdatedAt: '2026-01-10'
    })],
    [tx('btc', '2026-01-01', 'in', 4000, { unitsE8: L.UNIT_SCALE, unitPricePence: 400000 })]
  );
  // On the 1st the recorded price was 4,000 pounds a unit.
  assert.equal(L.netWorthAt(state, '2026-01-01').netWorthPence, 400000);
  // By the 10th the stored price of 80,000 pounds applies.
  assert.equal(L.netWorthAt(state, '2026-01-10').netWorthPence, 8000000);
});

test('units for pence converts back and forth without drift', () => {
  const price = 5000000;
  const units = L.unitsForPence(1000000, price); // 10,000 pounds worth
  assert.equal(units, L.UNIT_SCALE / 5);
  assert.equal(L.quantityValuePence(units, price), 1000000);
  assert.equal(L.unitsForPence(1000, 0), 0, 'a zero price cannot buy units');
});

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

test('impossible dates are rejected', () => {
  assert.equal(L.isValidISODate('2026-02-29'), false, '2026 is not a leap year');
  assert.equal(L.isValidISODate('2024-02-29'), true, '2024 is a leap year');
  assert.equal(L.isValidISODate('2026-13-01'), false);
  assert.equal(L.isValidISODate('2026-00-10'), false);
  assert.equal(L.isValidISODate('2026-04-31'), false);
  assert.equal(L.isValidISODate('26-04-01'), false);
  assert.equal(L.isValidISODate('2026-4-1'), false);
  assert.equal(L.isValidISODate(''), false);
  assert.equal(L.isValidISODate(null), false);
  assert.equal(L.isValidISODate(20260401), false);
});

test('days between is exact and never off by one across a daylight saving change', () => {
  // The UK clocks go forward on 2026-03-29 and back on 2026-10-25.
  assert.equal(L.daysBetween('2026-03-28', '2026-03-30'), 2);
  assert.equal(L.daysBetween('2026-10-24', '2026-10-26'), 2);
  assert.equal(L.daysBetween('2026-01-01', '2026-01-01'), 0);
  assert.equal(L.daysBetween('2026-01-02', '2026-01-01'), -1);
  assert.equal(L.addDays('2026-03-28', 2), '2026-03-30');
  assert.equal(L.addDays('2026-12-31', 1), '2027-01-01');
});

test('time remaining across a month boundary', () => {
  const tr = L.timeRemaining('2026-01-28', '2026-02-03');
  assert.deepEqual(
    { years: tr.years, months: tr.months, days: tr.days },
    { years: 0, months: 0, days: 6 }
  );
  assert.equal(tr.totalDays, 6);

  const tr2 = L.timeRemaining('2026-01-31', '2026-03-01');
  assert.equal(tr2.years, 0);
  assert.equal(tr2.months, 1);
  assert.equal(tr2.days, 1, '31 Jan to 1 Mar is one month and one day');
});

test('time remaining across a leap day', () => {
  const leap = L.timeRemaining('2024-02-28', '2024-03-01');
  assert.equal(leap.days, 2, '2024 has a 29th of February');
  assert.equal(leap.totalDays, 2);

  const common = L.timeRemaining('2023-02-28', '2023-03-01');
  assert.equal(common.days, 1, '2023 has no 29th of February');
  assert.equal(common.totalDays, 1);

  // 29 February plus one year clamps to 28 February, which is the end date.
  const year = L.timeRemaining('2024-02-29', '2025-02-28');
  assert.equal(year.years, 1);
  assert.equal(year.months, 0);
  assert.equal(year.days, 0);
  assert.equal(year.totalDays, 365);
});

test('time remaining reports the past correctly', () => {
  const past = L.timeRemaining('2026-08-26', '2026-08-01');
  assert.equal(past.past, true);
  assert.equal(past.totalDays, 25);
  assert.equal(L.describeTimeRemaining(past), '25 days ago');
});

test('time remaining reads as plain English', () => {
  assert.equal(
    L.describeTimeRemaining(L.timeRemaining('2026-08-26', '2028-10-29')),
    '2 years, 2 months and 3 days'
  );
  assert.equal(L.describeTimeRemaining(L.timeRemaining('2026-08-26', '2026-08-27')), '1 day');
  assert.equal(L.describeTimeRemaining(L.timeRemaining('2026-08-26', '2026-08-26')), '0 days');
});

test('adding months clamps to the end of a short month', () => {
  assert.equal(L.addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(L.addMonths('2024-01-31', 1), '2024-02-29');
  assert.equal(L.addMonths('2026-08-26', -12), '2025-08-26');
  assert.equal(L.addMonths('2026-12-15', 1), '2027-01-15');
});

/* ------------------------------------------------------------------ */
/* Goals                                                               */
/* ------------------------------------------------------------------ */

function goalAccount(goal, type = 'balance') {
  return account('lisa', 'Lifetime ISA', type, 'Property savings', { goal });
}

test('goal with a target date in the future', () => {
  const acc = goalAccount({
    targetPence: 2000000, // 20,000 pounds
    targetDate: '2027-08-26',
    startDate: '2026-08-26',
    startPence: 0
  });
  const p = L.goalProgress(acc, 500000, TODAY); // 5,000 pounds saved
  assert.equal(p.percent, 25);
  assert.equal(p.remainingPence, 1500000);
  assert.equal(p.daysRemaining, 365);
  assert.equal(p.reached, false);
  assert.equal(p.overdue, false);
  assert.equal(p.rates.perDayPence, Math.ceil(1500000 / 365));
  assert.equal(p.rates.perWeekPence, Math.ceil((1500000 * 7) / 365));
  assert.equal(p.rates.perMonthPence, Math.ceil((1500000 * L.DAYS_PER_MONTH) / 365));
  // Checked by hand: 15,000 pounds over 365 days is 41.10 a day.
  assert.equal(L.formatMoney(p.rates.perDayPence), '£41.10');
  assert.equal(L.formatMoney(p.rates.perWeekPence), '£287.68');
  assert.equal(p.timeRemaining.years, 1);
});

test('goal pace marker says ahead or behind correctly', () => {
  const acc = goalAccount({
    targetPence: 1200000, targetDate: '2027-08-26', startDate: '2026-08-26', startPence: 0
  });
  // Half way through the year you should be half way to the target.
  // 182 of the 365 days have passed, so a straight line wants 5,983.56.
  const halfway = L.goalProgress(acc, 600000, '2027-02-24');
  assert.equal(halfway.pace.expectedPence, 598356);
  assert.equal(halfway.pace.status, 'on track', 'being 16 pounds ahead on 12,000 is not news');
  assert.equal(halfway.pace.tolerancePence, 6000, 'half a percent of the goal');

  const behind = L.goalProgress(acc, 100000, '2027-02-24');
  assert.equal(behind.pace.status, 'behind');
  assert.ok(behind.pace.differencePence < 0);

  const ahead = L.goalProgress(acc, 1000000, '2027-02-24');
  assert.equal(ahead.pace.status, 'ahead');
  assert.ok(ahead.pace.differencePence > 0);
});

test('goal with a target date already in the past', () => {
  const acc = goalAccount({
    targetPence: 2000000, targetDate: '2026-01-01', startDate: '2025-01-01', startPence: 0
  });
  const p = L.goalProgress(acc, 500000, TODAY);
  assert.equal(p.overdue, true);
  assert.equal(p.status, 'overdue');
  assert.ok(p.daysRemaining < 0);
  assert.equal(p.rates.perDayPence, null, 'there is no rate that reaches a date already gone');
  assert.equal(p.rates.achievable, false);
  assert.equal(p.timeRemaining.past, true);
  assert.equal(p.remainingPence, 1500000);
});

test('goal already exceeded is capped at 100 percent but flagged', () => {
  const acc = goalAccount({
    targetPence: 1000000, targetDate: '2027-01-01', startDate: '2026-01-01', startPence: 0
  });
  const p = L.goalProgress(acc, 1500000, TODAY);
  assert.equal(p.percent, 100, 'the bar is capped');
  assert.equal(Math.round(p.rawPercent), 150, 'the real figure is still available');
  assert.equal(p.exceeded, true);
  assert.equal(p.reached, true);
  assert.equal(p.status, 'exceeded');
  assert.equal(p.remainingPence, 0);
  assert.equal(p.rates.perDayPence, 0);
});

test('a goal of zero is treated as already complete rather than dividing by zero', () => {
  const acc = goalAccount({
    targetPence: 0, targetDate: '2027-01-01', startDate: '2026-01-01', startPence: 0
  });
  const p = L.goalProgress(acc, 0, TODAY);
  assert.equal(Number.isFinite(p.percent), true);
  assert.equal(p.percent, 100);
  assert.equal(p.zeroTarget, true);
  assert.equal(p.remainingPence, 0);
  assert.equal(p.reached, true);
});

test('a goal on an account with a zero balance does not break', () => {
  const acc = goalAccount({
    targetPence: 500000, targetDate: '2027-01-01', startDate: '2026-01-01', startPence: 0
  });
  const p = L.goalProgress(acc, 0, TODAY);
  assert.equal(p.percent, 0);
  assert.equal(p.remainingPence, 500000);
  assert.equal(Number.isFinite(p.rates.perDayPence), true);
});

test('required rate with one day left, and with none', () => {
  const oneDay = L.requiredRates(123456, 1);
  assert.equal(oneDay.perDayPence, 123456, 'one day left means the whole amount today');
  assert.equal(oneDay.perWeekPence, 123456 * 7);
  assert.equal(oneDay.achievable, true);

  const noDays = L.requiredRates(123456, 0);
  assert.equal(noDays.perDayPence, null);
  assert.equal(noDays.perWeekPence, null);
  assert.equal(noDays.perMonthPence, null);
  assert.equal(noDays.achievable, false);

  const negative = L.requiredRates(123456, -10);
  assert.equal(negative.achievable, false);

  const done = L.requiredRates(0, 0);
  assert.equal(done.perDayPence, 0, 'nothing left to save means a rate of zero, not an error');
  assert.equal(done.achievable, true);
});

test('an account with no goal returns nothing rather than throwing', () => {
  assert.equal(L.goalProgress(account('x', 'X', 'balance', 'Cash'), 1000, TODAY), null);
  assert.equal(L.goalProgress(null, 1000, TODAY), null);
});

test('a debt goal counts down to zero rather than up to a target', () => {
  const debt = account('debt', 'Debt', 'liability', 'Debt', {
    interestRatePct: 0,
    goal: { targetPence: 0, targetDate: '2027-08-26', startDate: '2026-08-26', startPence: 500000 }
  });
  const p = L.goalProgress(debt, 250000, TODAY);
  assert.equal(p.isDebt, true);
  assert.equal(p.percent, 50, 'half the debt is paid off');
  assert.equal(p.remainingPence, 250000);
  assert.equal(p.reached, false);

  const cleared = L.goalProgress(debt, 0, TODAY);
  assert.equal(cleared.percent, 100);
  assert.equal(cleared.reached, true);
  assert.equal(cleared.remainingPence, 0);
});

/* ------------------------------------------------------------------ */
/* Debt payoff                                                         */
/* ------------------------------------------------------------------ */

test('debt payoff with no interest is simple division', () => {
  const p = L.projectPayoff(120000, 10000, 0, TODAY);
  assert.equal(p.months, 12);
  assert.equal(p.payoffDate, '2027-08-26');
  assert.equal(p.totalInterestPence, 0);
});

test('debt payoff with interest takes longer than without', () => {
  const withInterest = L.projectPayoff(500000, 25000, 18.9, TODAY);
  const without = L.projectPayoff(500000, 25000, 0, TODAY);
  assert.ok(withInterest.months > without.months);
  assert.equal(without.months, 20, '5,000 pounds at 250 a month is 20 months');
  assert.equal(withInterest.months, 25, 'checked against a month by month simulation');
  assert.ok(withInterest.totalInterestPence > 0);
  assert.equal(withInterest.reason, 'projected');
});

test('debt payoff reports honestly when the payment never clears the debt', () => {
  // 100 pounds a month against 5,000 pounds at 30 percent is interest only.
  const stuck = L.projectPayoff(500000, 10000, 30, TODAY);
  assert.equal(stuck.months, null);
  assert.equal(stuck.reason, 'payments do not cover the interest');

  const none = L.projectPayoff(500000, 0, 5, TODAY);
  assert.equal(none.months, null);
  assert.equal(none.reason, 'no payments recorded');

  const clear = L.projectPayoff(0, 10000, 5, TODAY);
  assert.equal(clear.months, 0);
  assert.equal(clear.reason, 'cleared');
});

test('average monthly repayment only counts payments, not new borrowing', () => {
  const state = makeState(
    [account('debt', 'Debt', 'liability', 'Debt')],
    [
      tx('debt', '2026-08-01', 'out', 300),
      tx('debt', '2026-07-01', 'out', 300),
      tx('debt', '2026-06-01', 'in', 1000),
      tx('debt', '2026-06-15', 'out', 300)
    ]
  );
  const average = L.averageMonthlyRepayment(state, 'debt', { today: TODAY, windowMonths: 6 });
  assert.equal(average, Math.round(90000 / 6));
});

/* ------------------------------------------------------------------ */
/* Withdrawal guard                                                    */
/* ------------------------------------------------------------------ */

test('a withdrawal larger than the balance is flagged rather than silently allowed', () => {
  const acc = account('savings', 'Savings account', 'balance', 'Cash');
  assert.equal(L.checkWithdrawal(acc, 10000, 5000).ok, true);
  assert.equal(L.checkWithdrawal(acc, 10000, 10000).ok, true, 'emptying an account is fine');
  const over = L.checkWithdrawal(acc, 10000, 15000);
  assert.equal(over.ok, false);
  assert.match(over.warning, /below zero/);
  assert.match(over.warning, /-£50\.00/);
  // A debt can always be increased, so it is never flagged.
  assert.equal(L.checkWithdrawal(account('d', 'Debt', 'liability', 'Debt'), 0, 100).ok, true);
});

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

test('currency formatting for zero, a large value and a negative value', () => {
  assert.equal(L.formatMoney(0), '£0.00');
  assert.equal(L.formatMoney(1), '£0.01');
  assert.equal(L.formatMoney(100), '£1.00');
  assert.equal(L.formatMoney(123456789), '£1,234,567.89');
  assert.equal(L.formatMoney(-123456), '-£1,234.56');
  assert.equal(L.formatMoney(-1), '-£0.01');
  assert.equal(L.formatMoney(NaN), '£0.00');
  assert.equal(L.formatMoney(undefined), '£0.00');
  assert.equal(L.formatMoney(50000, { showSign: true }), '+£500.00');
});

test('compact formatting only abbreviates above ten thousand pounds', () => {
  assert.equal(L.formatMoneyCompact(0), '£0.00');
  assert.equal(L.formatMoneyCompact(999999), '£9,999.99', 'just under ten thousand stays exact');
  assert.equal(L.formatMoneyCompact(1000000), '£10k');
  assert.equal(L.formatMoneyCompact(1234567), '£12.3k');
  assert.equal(L.formatMoneyCompact(123456789), '£1.23m');
  assert.equal(L.formatMoneyCompact(-1234567), '-£12.3k');
  assert.equal(L.formatMoneyCompact(100000000), '£1m');
});

test('units format without trailing zeros', () => {
  assert.equal(L.formatUnits(L.UNIT_SCALE), '1');
  assert.equal(L.formatUnits(L.UNIT_SCALE / 2), '0.5');
  assert.equal(L.formatUnits(12345678), '0.12345678');
  assert.equal(L.formatUnits(0), '0');
  assert.equal(L.formatUnits(1234 * L.UNIT_SCALE), '1,234');
});

test('money input rejects text and impossible amounts', () => {
  assert.equal(L.parseMoneyToPence('12.34').pence, 1234);
  assert.equal(L.parseMoneyToPence('£1,234.50').pence, 123450);
  assert.equal(L.parseMoneyToPence('  99 ').pence, 9900);
  assert.equal(L.parseMoneyToPence('abc').ok, false);
  assert.equal(L.parseMoneyToPence('12abc').ok, false);
  assert.equal(L.parseMoneyToPence('').ok, false);
  assert.equal(L.parseMoneyToPence('   ').ok, false);
  assert.equal(L.parseMoneyToPence('1.234').ok, false, 'more than two decimal places');
  assert.equal(L.parseMoneyToPence('-5').ok, false, 'negative rejected by default');
  assert.equal(L.parseMoneyToPence('-5', { allowNegative: true }).pence, -500);
  assert.equal(L.parseMoneyToPence('0').ok, false, 'zero rejected by default');
  assert.equal(L.parseMoneyToPence('0', { allowZero: true }).pence, 0);
  assert.equal(L.parseMoneyToPence('1e5').ok, false);
  assert.equal(L.parseMoneyToPence('NaN').ok, false);
  assert.equal(L.parseMoneyToPence(null).ok, false);
});

test('quantity input rejects text and takes eight decimal places', () => {
  assert.equal(L.parseUnitsToE8('1').unitsE8, L.UNIT_SCALE);
  assert.equal(L.parseUnitsToE8('0.12345678').unitsE8, 12345678);
  assert.equal(L.parseUnitsToE8('0.123456789').ok, false);
  assert.equal(L.parseUnitsToE8('abc').ok, false);
  assert.equal(L.parseUnitsToE8('-1').ok, false);
  assert.equal(L.parseUnitsToE8('0').ok, false);
});

/* ------------------------------------------------------------------ */
/* Category totals, allocation and contributions                       */
/* ------------------------------------------------------------------ */

test('category totals group accounts correctly', () => {
  const state = makeState(
    [
      account('sav', 'Savings', 'balance', 'Cash', { order: 0 }),
      account('cur', 'Current', 'balance', 'Cash', { order: 1 }),
      account('isa', 'ISA', 'balance', 'Investments', { order: 2 }),
      account('debt', 'Debt', 'liability', 'Debt', { order: 3 })
    ],
    [
      tx('sav', '2026-01-01', 'in', 1000),
      tx('cur', '2026-01-01', 'in', 500),
      tx('isa', '2026-01-01', 'in', 2000),
      tx('debt', '2026-01-01', 'in', 750)
    ]
  );
  const totals = L.categoryTotals(state, TODAY);
  assert.equal(totals.Cash, 150000);
  assert.equal(totals.Investments, 200000);
  assert.equal(totals.Debt, 75000);
  assert.equal(totals.Crypto, 0);

  const allocation = L.allocationByCategory(state, TODAY);
  const cash = allocation.find((r) => r.name === 'Cash');
  const investments = allocation.find((r) => r.name === 'Investments');
  assert.equal(Math.round(cash.fraction * 100), 43);
  assert.equal(Math.round(investments.fraction * 100), 57);
  assert.equal(allocation.some((r) => r.name === 'Debt'), false, 'debt is not an allocation');
  const sum = allocation.reduce((s, r) => s + r.fraction, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test('allocation with no data returns zero fractions rather than NaN', () => {
  const state = makeState([account('sav', 'Savings', 'balance', 'Cash')], []);
  const allocation = L.allocationByCategory(state, TODAY);
  assert.ok(allocation.every((r) => r.fraction === 0));
  assert.ok(allocation.every((r) => Number.isFinite(r.fraction)));
});

test('position series sorts by value with debt last', () => {
  const state = makeState(
    [
      account('small', 'Small', 'balance', 'Cash', { order: 0 }),
      account('big', 'Big', 'balance', 'Investments', { order: 1 }),
      account('debt', 'Debt', 'liability', 'Debt', { order: 2 })
    ],
    [
      tx('small', '2026-01-01', 'in', 100),
      tx('big', '2026-01-01', 'in', 9000),
      tx('debt', '2026-01-01', 'in', 3000)
    ]
  );
  const rows = L.positionSeries(state, TODAY);
  assert.deepEqual(rows.map((r) => r.name), ['Big', 'Small', 'Debt']);
  assert.equal(rows[0].valuePence, 900000);
  assert.equal(rows[2].valuePence, -300000, 'debt sits below the axis');
  assert.equal(rows[2].colour, L.LIABILITY_COLOUR);
});

test('contributions bucket into the right months', () => {
  const state = makeState(
    [account('sav', 'Savings', 'balance', 'Cash')],
    [
      tx('sav', '2026-08-01', 'in', 500),
      tx('sav', '2026-08-20', 'in', 250),
      tx('sav', '2026-08-25', 'out', 100),
      tx('sav', '2026-07-15', 'in', 400),
      tx('sav', '2024-01-01', 'in', 9999) // outside the 12 month window
    ]
  );
  const rows = L.contributionsByMonth(state, { today: TODAY, months: 12 });
  assert.equal(rows.length, 12);
  assert.equal(rows[rows.length - 1].month, '2026-08');
  assert.equal(rows[rows.length - 1].inPence, 75000);
  assert.equal(rows[rows.length - 1].outPence, 10000);
  assert.equal(rows[rows.length - 1].netPence, 65000);
  assert.equal(rows[rows.length - 2].month, '2026-07');
  assert.equal(rows[rows.length - 2].inPence, 40000);
  assert.equal(rows.reduce((s, r) => s + r.inPence, 0), 115000, 'the old entry is excluded');
});

/* ------------------------------------------------------------------ */
/* CSV                                                                 */
/* ------------------------------------------------------------------ */

test('CSV export escapes commas and quotes in notes', () => {
  const state = makeState(
    [account('sav', 'Savings, main', 'balance', 'Cash')],
    [tx('sav', '2026-01-01', 'in', 12.5, { note: 'Said "hello", then left' })]
  );
  const csv = L.transactionsToCsv(state);
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], 'Date,Account,Category,Type,Direction,Amount (GBP),Units,Unit price (GBP),Note');
  assert.equal(lines[1], '2026-01-01,"Savings, main",Cash,balance,In,12.50,,,"Said ""hello"", then left"');
});

test('CSV marks withdrawals with a minus sign', () => {
  const state = makeState(
    [account('sav', 'Savings', 'balance', 'Cash')],
    [tx('sav', '2026-01-02', 'out', 40)]
  );
  assert.match(L.transactionsToCsv(state), /2026-01-02,Savings,Cash,balance,Out,-40\.00/);
});

test('CSV of an empty ledger is still a valid file with headers', () => {
  const csv = L.transactionsToCsv(makeState([], []));
  assert.equal(csv, `${L.CSV_HEADERS.join(',')}\r\n`);
});

/* ------------------------------------------------------------------ */
/* Import validation                                                   */
/* ------------------------------------------------------------------ */

test('import rejects an empty file', () => {
  assert.equal(L.validateImport(null).ok, false);
  assert.equal(L.validateImport(undefined).ok, false);
  assert.match(L.validateImport(null).errors[0], /empty/i);
});

test('import rejects something that is not a backup', () => {
  assert.equal(L.validateImport('a string').ok, false);
  assert.equal(L.validateImport([1, 2, 3]).ok, false);
  assert.equal(L.validateImport(42).ok, false);
  assert.equal(L.validateImport({}).ok, false);
  assert.match(L.validateImport({}).errors[0], /no accounts or transactions/i);
});

test('import rejects the right shape with the wrong types', () => {
  const wrong = L.validateImport({
    schemaVersion: 1,
    accounts: [{ id: 'a', name: 'A', type: 'balance' }],
    transactions: [
      { id: 't', accountId: 'a', date: '2026-01-01', direction: 'in', amountPence: 'lots' }
    ]
  });
  assert.equal(wrong.ok, false);
  assert.match(wrong.errors.join(' '), /amount that is not a number/);

  const badDate = L.validateImport({
    accounts: [{ id: 'a', name: 'A', type: 'balance' }],
    transactions: [{ accountId: 'a', date: '2026-02-30', direction: 'in', amountPence: 1 }]
  });
  assert.equal(badDate.ok, false);
  assert.match(badDate.errors.join(' '), /impossible date/);

  const badType = L.validateImport({
    accounts: [{ id: 'a', name: 'A', type: 'wormhole' }],
    transactions: []
  });
  assert.equal(badType.ok, false);
  assert.match(badType.errors.join(' '), /unknown type/);

  const orphan = L.validateImport({
    accounts: [{ id: 'a', name: 'A', type: 'balance' }],
    transactions: [{ accountId: 'ghost', date: '2026-01-01', direction: 'in', amountPence: 1 }]
  });
  assert.equal(orphan.ok, false);
  assert.match(orphan.errors.join(' '), /not in the file/);

  const listsNotLists = L.validateImport({ accounts: 'nope', transactions: 'nope' });
  assert.equal(listsNotLists.ok, false);

  const fromTheFuture = L.validateImport({
    schemaVersion: 999, accounts: [], transactions: []
  });
  assert.equal(fromTheFuture.ok, false);
  assert.match(fromTheFuture.errors.join(' '), /newer version/);
});

test('import accepts a real export', () => {
  const state = makeState(
    [account('sav', 'Savings', 'balance', 'Cash')],
    [tx('sav', '2026-01-01', 'in', 100)]
  );
  const roundTripped = JSON.parse(JSON.stringify(state));
  const result = L.validateImport(roundTripped);
  assert.equal(result.ok, true, result.errors.join(' '));
  assert.deepEqual(result.errors, []);
});

test('export then import reproduces exactly the same state', () => {
  const state = makeState(
    [
      account('btc', 'Bitcoin', 'quantity', 'Crypto', { unit: 'BTC', unitPricePence: 5000000 }),
      account('debt', 'Debt', 'liability', 'Debt', {
        interestRatePct: 6.5,
        goal: { targetPence: 0, targetDate: '2028-01-01', startDate: '2026-01-01', startPence: 300000 }
      })
    ],
    [
      tx('btc', '2026-01-01', 'in', 1000, { unitsE8: L.UNIT_SCALE / 50, unitPricePence: 5000000 }),
      tx('debt', '2026-02-01', 'out', 250)
    ]
  );
  const json = JSON.stringify(state);
  const back = L.normaliseState(JSON.parse(json), TODAY);
  assert.deepEqual(back, state);
  assert.equal(L.netWorthAt(back, TODAY).netWorthPence, L.netWorthAt(state, TODAY).netWorthPence);
});

/* ------------------------------------------------------------------ */
/* Migration                                                           */
/* ------------------------------------------------------------------ */

test('a version 0 saved object migrates to the current schema without losing data', () => {
  const old = {
    // No schemaVersion at all, money as floating point pounds.
    accounts: [
      { id: 'sav', name: 'Savings', type: 'balance', category: 'Cash', goalTarget: 10000, goalDate: '2027-01-01' },
      { id: 'btc', name: 'Bitcoin', units: 0.5, unit: 'BTC', unitPrice: 42000.5, category: 'Crypto' },
      { id: 'debt', name: 'Debt', isDebt: true, interestRate: 7.5 }
    ],
    transactions: [
      { id: 't1', accountId: 'sav', date: '2026-01-01', amount: 1234.56 },
      { id: 't2', accountId: 'sav', date: '2026-02-01', amount: -34.56 },
      { id: 't3', accountId: 'btc', date: '2026-01-15', amount: 21000.25, units: 0.5, unitPrice: 42000.5 }
    ]
  };
  const { state, migratedFrom } = L.migrate(old, TODAY);

  assert.equal(migratedFrom, 0);
  assert.equal(state.schemaVersion, L.SCHEMA_VERSION);
  assert.equal(state.accounts.length, 3);
  assert.equal(state.transactions.length, 3);

  // Money is now integer pence.
  const sav = state.transactions.find((t) => t.id === 't1');
  assert.equal(sav.amountPence, 123456);
  assert.equal(sav.direction, 'in');
  const out = state.transactions.find((t) => t.id === 't2');
  assert.equal(out.amountPence, 3456);
  assert.equal(out.direction, 'out', 'a negative amount becomes a withdrawal');

  // Types were inferred.
  assert.equal(state.accounts.find((a) => a.id === 'btc').type, 'quantity');
  assert.equal(state.accounts.find((a) => a.id === 'btc').unitPricePence, 4200050);
  assert.equal(state.accounts.find((a) => a.id === 'debt').type, 'liability');
  assert.equal(state.accounts.find((a) => a.id === 'debt').interestRatePct, 7.5);

  // The goal came across as pence.
  assert.equal(state.accounts.find((a) => a.id === 'sav').goal.targetPence, 1000000);
  assert.equal(state.accounts.find((a) => a.id === 'sav').goal.targetDate, '2027-01-01');

  // And the numbers still add up.
  assert.equal(L.balancesAt(state, TODAY).get('sav').valuePence, 120000);
  assert.equal(state.visuals.length, L.DEFAULT_VISUALS.length);
});

test('migration is not applied twice to an already current object', () => {
  const state = makeState([account('sav', 'Savings', 'balance', 'Cash')], [tx('sav', '2026-01-01', 'in', 100)]);
  const { state: again, migratedFrom } = L.migrate(JSON.parse(JSON.stringify(state)), TODAY);
  assert.equal(migratedFrom, null);
  assert.equal(again.transactions[0].amountPence, 10000);
});

test('migration copes with rubbish input rather than wiping data', () => {
  assert.deepEqual(L.migrate(null, TODAY).state.accounts, []);
  assert.deepEqual(L.migrate('nonsense', TODAY).state.accounts, []);
  const partial = L.migrate({ accounts: [{ name: 'No id' }] }, TODAY).state;
  assert.equal(partial.accounts.length, 1);
  assert.ok(partial.accounts[0].id, 'a missing id is filled in rather than dropped');
});

test('normalising keeps saved visual order and adds anything new', () => {
  const state = L.normaliseState({
    accounts: [], transactions: [],
    visuals: [{ id: 'goals', enabled: true, order: 0 }, { id: 'netWorth', enabled: false, order: 1 }]
  }, TODAY);
  assert.equal(state.visuals[0].id, 'goals');
  assert.equal(state.visuals[1].id, 'netWorth');
  assert.equal(state.visuals[1].enabled, false);
  assert.equal(state.visuals.length, L.DEFAULT_VISUALS.length, 'new visuals are appended');
  assert.ok(state.visuals.every((v, i) => v.order === i));
});

/* ------------------------------------------------------------------ */
/* Ranges and chart helpers                                            */
/* ------------------------------------------------------------------ */

test('range presets clamp to the first transaction', () => {
  const state = makeState(
    [account('sav', 'Savings', 'balance', 'Cash')],
    [tx('sav', '2026-06-01', 'in', 100)]
  );
  assert.equal(L.rangeStartDate('1m', state, TODAY), '2026-07-26');
  assert.equal(L.rangeStartDate('1y', state, TODAY), '2026-06-01', 'clamped to the first entry');
  assert.equal(L.rangeStartDate('all', state, TODAY), '2026-06-01');
  const empty = makeState([], []);
  assert.equal(L.rangeStartDate('all', empty, TODAY), TODAY);
});

test('nice scale produces round numbers that contain the data', () => {
  const scale = L.niceScale(0, 9700, 4);
  assert.ok(scale.max >= 9700);
  assert.ok(scale.min <= 0);
  assert.ok(scale.ticks.length >= 2);
  const flat = L.niceScale(500, 500);
  assert.ok(flat.max > flat.min, 'a flat series still gets a usable axis');
  const nonsense = L.niceScale(NaN, NaN);
  assert.ok(Number.isFinite(nonsense.min) && Number.isFinite(nonsense.max));
});

test('series sampling keeps the first and last point', () => {
  const series = Array.from({ length: 400 }, (_, i) => ({ date: `d${i}`, netWorthPence: i }));
  const sampled = L.sampleSeries(series, 60);
  assert.equal(sampled.length, 60);
  assert.equal(sampled[0].netWorthPence, 0);
  assert.equal(sampled[sampled.length - 1].netWorthPence, 399);
  assert.equal(L.sampleSeries(series.slice(0, 10), 60).length, 10);
});

test('series change reports the move over the window', () => {
  const change = L.seriesChange([{ netWorthPence: 10000 }, { netWorthPence: 12000 }]);
  assert.equal(change.absolutePence, 2000);
  assert.equal(Math.round(change.fraction * 100), 20);
  const fromZero = L.seriesChange([{ netWorthPence: 0 }, { netWorthPence: 5000 }]);
  assert.equal(fromZero.hasBase, false, 'no percentage is possible from a zero base');
  assert.equal(L.seriesChange([]).absolutePence, 0);
});

/* ------------------------------------------------------------------ */
/* Chart titles state the finding                                      */
/* ------------------------------------------------------------------ */

test('chart titles say what happened rather than naming the chart', () => {
  const rising = [{ netWorthPence: 100000 }, { netWorthPence: 112000 }];
  assert.equal(L.netWorthTitle(rising, '1y'), 'Net worth up 12.0 percent over the last 1 year');
  const falling = [{ netWorthPence: 100000 }, { netWorthPence: 90000 }];
  assert.match(L.netWorthTitle(falling, '6m'), /^Net worth down 10\.0 percent/);
  assert.match(L.netWorthTitle([], 'all'), /needs a few entries/);
  assert.match(L.netWorthTitle([{ netWorthPence: 5 }, { netWorthPence: 5 }], '1m'), /unchanged/);
});

test('empty visuals still get a sensible title rather than a blank one', () => {
  assert.equal(L.positionTitle([]), 'No account holds a balance yet');
  assert.equal(L.allocationTitle([]), 'Nothing to allocate yet');
  assert.equal(L.goalsTitle([]), 'No goals set yet');
  assert.match(L.contributionsTitle([]), /No money in or out/);
  assert.match(L.holdingsTitle([]), /No quantity based holdings/);
  assert.equal(L.categoryTotalsTitle([]), 'No category holds a balance yet');
});

/* ------------------------------------------------------------------ */
/* Palette. These prove the accessibility claims rather than assuming. */
/* ------------------------------------------------------------------ */

test('every body text colour reaches WCAG AA in both themes', () => {
  for (const theme of ['light', 'dark']) {
    const t = L.THEME_COLOURS[theme];
    for (const textKey of ['ink', 'muted', 'positiveText', 'negativeText', 'accentText']) {
      for (const bgKey of ['surface', 'canvas']) {
        const ratio = L.contrastRatio(t[textKey], t[bgKey]);
        assert.ok(
          ratio >= 4.5,
          `${theme}: ${textKey} on ${bgKey} is ${ratio.toFixed(2)} to 1, below the 4.5 minimum`
        );
      }
    }
  }
});

test('the two supporting colours that fail as text have safe replacements', () => {
  // Recorded on purpose so the reason for the extra tokens stays visible.
  assert.ok(L.contrastRatio('#1E8C6E', '#FFFFFF') < 4.5, '--positive is not AA as text');
  assert.ok(L.contrastRatio('#E0A33D', '#FFFFFF') < 4.5, '--accent is not AA as text');
  assert.ok(L.contrastRatio(L.THEME_COLOURS.light.positiveText, '#FFFFFF') >= 4.5);
  assert.ok(L.contrastRatio(L.THEME_COLOURS.light.accentText, '#FFFFFF') >= 4.5);
});

test('a label placed on any account colour is readable', () => {
  for (const stop of L.PHTHALO_SCALE) {
    const text = L.readableTextOn(stop.hex);
    assert.ok(
      L.contrastRatio(text, stop.hex) >= 4.5,
      `${stop.token} cannot carry a readable label`
    );
  }
  assert.ok(L.contrastRatio(L.readableTextOn(L.LIABILITY_COLOUR), L.LIABILITY_COLOUR) >= 4.5);
});

test('account colours walk down the scale and keep categories together', () => {
  const accounts = [
    { id: 'btc', category: 'Crypto', type: 'quantity', order: 0 },
    { id: 'eth', category: 'Crypto', type: 'quantity', order: 1 },
    { id: 'sol', category: 'Crypto', type: 'quantity', order: 2 },
    { id: 'gold', category: 'Precious metals', type: 'quantity', order: 3 },
    { id: 'silver', category: 'Precious metals', type: 'quantity', order: 4 },
    { id: 'lisa', category: 'Property savings', type: 'balance', order: 5 },
    { id: 'isa', category: 'Investments', type: 'balance', order: 6 },
    { id: 'sav', category: 'Cash', type: 'balance', order: 7 },
    { id: 'cur', category: 'Cash', type: 'balance', order: 8 },
    { id: 'debt', category: 'Debt', type: 'liability', order: 9 }
  ];
  const slots = L.assignAccountColours(accounts);
  assert.equal(slots.get('btc'), 0);
  assert.equal(slots.get('eth'), 1);
  assert.equal(slots.get('sol'), 2);
  assert.equal(slots.get('gold'), 3);
  assert.equal(slots.get('cur'), 8);
  assert.equal(slots.has('debt'), false, 'the debt is not on the blue scale');

  // Every asset account gets its own distinct slot.
  const used = Array.from(slots.values());
  assert.equal(new Set(used).size, used.length);

  // The debt keeps the reserved red and nothing else uses it.
  const colours = accounts.map((a) => L.colourForAccount({ ...a, colourIndex: slots.get(a.id) }));
  assert.equal(colours[colours.length - 1], L.LIABILITY_COLOUR);
  assert.equal(colours.filter((c) => c === L.LIABILITY_COLOUR).length, 1);
});

test('the five categories that touch in the stacked bar are measurably separated', () => {
  const colours = L.CATEGORIES.filter((c) => c !== 'Debt').map((c) => L.CATEGORY_COLOURS[c]);
  const report = L.separationReport(colours);
  // Measured, not assumed. Nine accounts cannot all sit 15 points apart on
  // an eleven stop single hue scale, so this records what is actually true.
  assert.ok(report.minimumPairwiseGap >= 11, `min gap was ${report.minimumPairwiseGap}`);
  assert.ok(report.pairs.every((p) => p.contrast > 1.2), 'adjacent segments stay distinguishable in greyscale');
  assert.equal(new Set(colours).size, colours.length, 'no two categories share a colour');
});

/* ------------------------------------------------------------------ */
/* Demo data                                                           */
/* ------------------------------------------------------------------ */

test('the demo data is internally consistent', async () => {
  const seed = await import('../src/seed.js');
  const state = seed.demoState(TODAY);

  assert.equal(state.accounts.length, 10);
  assert.ok(state.transactions.length > 100, 'twelve months of activity');
  assert.equal(L.validateImport(JSON.parse(JSON.stringify(state))).ok, true);

  // No account may end up holding a negative amount of anything. This is
  // the bug the generator originally had, where it sold Solana it had
  // never bought.
  for (const row of L.positionSeries(state, TODAY)) {
    if (row.type === 'liability') {
      assert.ok(row.valuePence <= 0, `${row.name} debt should sit below the axis`);
    } else {
      assert.ok(row.valuePence >= 0, `${row.name} should not be worth less than nothing`);
      assert.ok(row.unitsE8 >= 0, `${row.name} should not hold negative units`);
    }
  }

  // Every transaction falls inside the last thirteen months.
  const earliest = L.earliestTransactionDate(state);
  assert.ok(earliest >= L.addMonths(TODAY, -13));
  assert.ok(state.transactions.every((t) => t.date <= TODAY), 'nothing is dated in the future');

  // The series runs continuously to today with no gaps.
  const series = L.buildDailySeries(state, { today: TODAY });
  assert.equal(series[series.length - 1].date, TODAY);
  for (let i = 1; i < series.length; i += 1) {
    assert.equal(L.daysBetween(series[i - 1].date, series[i].date), 1, 'no gaps in the daily series');
  }
  assert.equal(series[series.length - 1].netWorthPence, L.netWorthAt(state, TODAY).netWorthPence);
});

test('the demo data is the same every time it is generated', async () => {
  const seed = await import('../src/seed.js');
  assert.deepEqual(seed.demoState(TODAY), seed.demoState(TODAY));
});

test('a brand new install has the ten default accounts and no transactions', async () => {
  const seed = await import('../src/seed.js');
  const state = seed.emptyStateWithDefaults(TODAY);
  assert.equal(state.accounts.length, 10);
  assert.equal(state.transactions.length, 0);
  assert.equal(L.netWorthAt(state, TODAY).netWorthPence, 0);

  // Every default account has a distinct colour and the debt keeps the red.
  const colours = state.accounts.map((a) => L.colourForAccount(a));
  assert.equal(new Set(colours).size, colours.length, 'no two default accounts share a colour');
  assert.equal(colours[colours.length - 1], L.LIABILITY_COLOUR);

  // Charts must have something sensible to draw with no data at all.
  assert.equal(L.buildDailySeries(state, { today: TODAY }).length, 1);
  assert.ok(L.allocationByCategory(state, TODAY).every((r) => r.fraction === 0));
  assert.equal(L.contributionsByMonth(state, { today: TODAY }).length, 12);
});

/* ------------------------------------------------------------------ */
/* Price refresh                                                       */
/*                                                                     */
/* fetch is stubbed here. The live endpoints are deliberately not       */
/* called by the test suite, so the tests stay offline and repeatable.  */
/* ------------------------------------------------------------------ */

const quantityAccounts = [
  { id: 'acc_bitcoin', name: 'Bitcoin', type: 'quantity', unitPricePence: 100, archived: false },
  { id: 'acc_gold', name: 'Gold', type: 'quantity', unitPricePence: 200, archived: false },
  { id: 'acc_savings', name: 'Savings', type: 'balance', archived: false },
  { id: 'acc_mystery', name: 'Palladium', type: 'quantity', unitPricePence: 300, archived: false }
];

async function withStubbedFetch(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await run();
  } finally {
    if (original === undefined) delete globalThis.fetch;
    else globalThis.fetch = original;
  }
}

function jsonResponse(body, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body))
  });
}

test('a good price response is parsed into pence', async () => {
  const prices = await import('../src/prices.js');
  const result = await withStubbedFetch((url) => {
    if (String(url).includes('coingecko')) return jsonResponse({ bitcoin: { gbp: 68000.55 } });
    if (String(url).includes('frankfurter')) return jsonResponse({ rates: { GBP: 0.8 } });
    if (String(url).includes('XAU')) return jsonResponse({ price: 2500 });
    return jsonResponse({}, 404);
  }, () => prices.fetchPrices(quantityAccounts));

  assert.equal(result.prices.get('acc_bitcoin'), 6800055, 'pounds converted to whole pence');
  assert.equal(result.prices.get('acc_gold'), 200000, '2500 dollars at 0.8 is 2000 pounds');
  assert.equal(result.prices.has('acc_savings'), false, 'balance accounts have no unit price');
  assert.equal(result.skipped.length, 1, 'an unknown symbol is skipped, not failed');
  assert.equal(result.skipped[0].name, 'Palladium');
  assert.equal(result.failures.length, 0);
});

test('a malformed price response is treated as a failure, not as a price', async () => {
  const prices = await import('../src/prices.js');
  const result = await withStubbedFetch(() => jsonResponse('<html>not json</html>'),
    () => prices.fetchPrices(quantityAccounts));
  assert.equal(result.prices.size, 0, 'no price is taken from rubbish');
  assert.ok(result.failures.length >= 1);
  assert.match(result.failures[0].reason, /not JSON/i);
});

test('a rate limited or dead endpoint fails safely', async () => {
  const prices = await import('../src/prices.js');
  const result = await withStubbedFetch(() => jsonResponse({ error: 'slow down' }, 429),
    () => prices.fetchPrices(quantityAccounts));
  assert.equal(result.prices.size, 0);
  assert.match(result.failures[0].reason, /429/);
  assert.match(prices.describeResult(result), /kept the last manual price/);
});

test('a thrown fetch, which is what offline looks like, fails safely', async () => {
  const prices = await import('../src/prices.js');
  const result = await withStubbedFetch(() => Promise.reject(new TypeError('Failed to fetch')),
    () => prices.fetchPrices(quantityAccounts));
  assert.equal(result.prices.size, 0);
  assert.match(result.failures[0].reason, /Could not reach/);
});

test('a price of zero or a negative price is refused', async () => {
  const prices = await import('../src/prices.js');
  const result = await withStubbedFetch((url) => {
    if (String(url).includes('coingecko')) return jsonResponse({ bitcoin: { gbp: 0 } });
    if (String(url).includes('frankfurter')) return jsonResponse({ rates: { GBP: 0.8 } });
    return jsonResponse({ price: -5 });
  }, () => prices.fetchPrices(quantityAccounts));
  assert.equal(result.prices.size, 0, 'a nonsense price never replaces a manual one');
  assert.equal(result.failures.length, 2);
});

test('the refresh gives up after five seconds rather than hanging', async () => {
  const prices = await import('../src/prices.js');
  assert.equal(prices.REQUEST_TIMEOUT_MS, 5000);

  // A fetch that never settles unless it is aborted.
  const result = await withStubbedFetch((url, options) => new Promise((resolve, reject) => {
    const signal = options && options.signal;
    if (!signal) return;
    if (signal.aborted) {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
      return;
    }
    signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  }), () => prices.fetchPrices([quantityAccounts[0]]));

  assert.equal(result.prices.size, 0);
  assert.match(result.failures[0].reason, /No reply within 5 seconds/);
});

test('which symbol to look up is worked out from the account', async () => {
  const prices = await import('../src/prices.js');
  assert.deepEqual(prices.symbolFor({ id: 'acc_gold', type: 'quantity' }), { kind: 'metal', id: 'XAU' });
  assert.deepEqual(prices.symbolFor({ id: 'custom', name: 'Bitcoin', type: 'quantity' }),
    { kind: 'crypto', id: 'bitcoin' });
  assert.deepEqual(prices.symbolFor({ id: 'x', type: 'quantity', priceKind: 'crypto', priceSymbol: 'cardano' }),
    { kind: 'crypto', id: 'cardano' });
  assert.equal(prices.symbolFor({ id: 'x', name: 'Premium Bonds', type: 'balance' }), null);
  assert.equal(prices.symbolFor(null), null);
});
