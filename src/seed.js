/**
 * seed.js
 *
 * The default set of accounts created on first run, and twelve months of
 * realistic sample transactions behind the "Load demo data" button.
 *
 * The demo is generated from a fixed seed, so it is the same every time
 * and the test suite can rely on it.
 */

import {
  UNIT_SCALE,
  addMonths,
  assignAccountColours,
  daysInMonth,
  normaliseState,
  startOfMonth,
  toISODate,
  parseISODate,
  quantityValuePence,
  unitsForPence
} from './logic.js';

/** Small deterministic generator so the demo never shifts about. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a += 0x6D2B79F5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DEFAULT_ACCOUNT_TEMPLATES = [
  {
    id: 'acc_bitcoin', name: 'Bitcoin', type: 'quantity', category: 'Crypto',
    unit: 'BTC', unitPricePence: 6800000
  },
  {
    id: 'acc_ethereum', name: 'Ethereum', type: 'quantity', category: 'Crypto',
    unit: 'ETH', unitPricePence: 290000
  },
  {
    id: 'acc_solana', name: 'Solana', type: 'quantity', category: 'Crypto',
    unit: 'SOL', unitPricePence: 14500
  },
  {
    id: 'acc_gold', name: 'Gold', type: 'quantity', category: 'Precious metals',
    unit: 'oz', unitPricePence: 205000
  },
  {
    id: 'acc_silver', name: 'Silver', type: 'quantity', category: 'Precious metals',
    unit: 'oz', unitPricePence: 2450
  },
  {
    id: 'acc_lisa', name: 'Lifetime ISA', type: 'balance', category: 'Property savings',
    note: 'House deposit'
  },
  {
    id: 'acc_ssisa', name: 'Stocks and Shares ISA', type: 'balance', category: 'Investments'
  },
  {
    id: 'acc_savings', name: 'Savings account', type: 'balance', category: 'Cash'
  },
  {
    id: 'acc_current', name: 'Current account', type: 'balance', category: 'Cash'
  },
  {
    id: 'acc_debt', name: 'Debt', type: 'liability', category: 'Debt', interestRatePct: 6.9
  }
];

/** The accounts a brand new install starts with. No transactions. */
export function defaultAccounts() {
  const accounts = DEFAULT_ACCOUNT_TEMPLATES.map((template, i) => ({
    order: i,
    archived: false,
    goal: null,
    note: '',
    colourIndex: i,
    ...template,
    ...(template.type === 'quantity'
      ? { priceUpdatedAt: null, priceSource: 'manual' }
      : {})
  }));
  const slots = assignAccountColours(accounts);
  return accounts.map((a) => ({
    ...a,
    colourIndex: slots.has(a.id) ? slots.get(a.id) : a.colourIndex
  }));
}

export function emptyStateWithDefaults(todayISO) {
  const state = normaliseState({ accounts: defaultAccounts(), transactions: [] }, todayISO);
  state.createdAt = todayISO;
  return state;
}

/* ------------------------------------------------------------------ */
/* Demo data                                                           */
/* ------------------------------------------------------------------ */

/** A date inside a given month, clamped to a day that exists. */
function dayIn(monthISO, day) {
  const { year, month } = parseISODate(monthISO);
  return toISODate(year, month, Math.min(day, daysInMonth(year, month)));
}

/**
 * Twelve months of plausible activity: a monthly pay in, regular savings,
 * a few crypto and metals purchases, some spending, and a debt being paid
 * down. Prices drift month by month so the history is not a straight line.
 */
export function demoState(todayISO) {
  const random = mulberry32(20260826);
  const accounts = defaultAccounts();
  const transactions = [];
  let sequence = 0;

  const held = new Map();      // units for quantity accounts
  const balance = new Map();   // pence for balance accounts

  const add = (accountId, date, direction, amountPence, extra = {}) => {
    // The current month is not over yet, so anything dated after today is
    // simply left out rather than pretending it has already happened.
    if (date > todayISO) return;
    const sign = direction === 'out' ? -1 : 1;
    held.set(accountId, (held.get(accountId) || 0) + (sign * Math.abs(extra.unitsE8 || 0)));
    balance.set(accountId, (balance.get(accountId) || 0) + (sign * Math.abs(amountPence)));
    sequence += 1;
    transactions.push({
      id: `demo_${String(sequence).padStart(4, '0')}`,
      accountId,
      date,
      direction,
      amountPence: Math.round(Math.abs(amountPence)),
      unitsE8: 0,
      unitPricePence: null,
      note: '',
      createdAt: `${date}T09:0${sequence % 10}:00.000Z`,
      ...extra
    });
  };

  // Unit prices twelve months ago, drifting up and down to today's values.
  const priceTracks = {
    acc_bitcoin: { start: 4200000, end: 6800000, wobble: 0.12 },
    acc_ethereum: { start: 210000, end: 290000, wobble: 0.14 },
    acc_solana: { start: 9500, end: 14500, wobble: 0.18 },
    acc_gold: { start: 178000, end: 205000, wobble: 0.04 },
    acc_silver: { start: 1980, end: 2450, wobble: 0.07 }
  };

  const priceFor = (accountId, monthIndex, months) => {
    const track = priceTracks[accountId];
    const progress = months <= 1 ? 1 : monthIndex / (months - 1);
    const trend = track.start + ((track.end - track.start) * progress);
    const noise = 1 + ((random() - 0.5) * 2 * track.wobble);
    return Math.max(1, Math.round(trend * noise));
  };

  const MONTHS = 13; // twelve full months plus the current one
  const firstMonth = startOfMonth(addMonths(todayISO, -(MONTHS - 1)));

  // The debt starts at 4,800 pounds and gets paid down.
  add('acc_debt', dayIn(firstMonth, 2), 'in', 480000, { note: 'Opening balance' });

  // Opening balances for the cash accounts.
  add('acc_current', dayIn(firstMonth, 1), 'in', 142000, { note: 'Opening balance' });
  add('acc_savings', dayIn(firstMonth, 1), 'in', 210000, { note: 'Opening balance' });
  add('acc_lisa', dayIn(firstMonth, 1), 'in', 640000, { note: 'Opening balance' });
  add('acc_ssisa', dayIn(firstMonth, 1), 'in', 895000, { note: 'Opening balance' });

  // Opening holdings.
  const openingBtcPrice = priceFor('acc_bitcoin', 0, MONTHS);
  add('acc_bitcoin', dayIn(firstMonth, 1), 'in', Math.round(0.038 * openingBtcPrice), {
    unitsE8: Math.round(0.038 * UNIT_SCALE), unitPricePence: openingBtcPrice, note: 'Opening holding'
  });
  const openingEthPrice = priceFor('acc_ethereum', 0, MONTHS);
  add('acc_ethereum', dayIn(firstMonth, 1), 'in', Math.round(0.6 * openingEthPrice), {
    unitsE8: Math.round(0.6 * UNIT_SCALE), unitPricePence: openingEthPrice, note: 'Opening holding'
  });
  const openingGoldPrice = priceFor('acc_gold', 0, MONTHS);
  add('acc_gold', dayIn(firstMonth, 1), 'in', Math.round(1.5 * openingGoldPrice), {
    unitsE8: Math.round(1.5 * UNIT_SCALE), unitPricePence: openingGoldPrice, note: 'Opening holding'
  });

  for (let i = 0; i < MONTHS; i += 1) {
    const month = startOfMonth(addMonths(firstMonth, i));
    const isCurrentMonth = i === MONTHS - 1;

    // Pay in, then the standing orders that go out of it.
    const pay = 268000 + Math.round(random() * 24000);
    add('acc_current', dayIn(month, 25), 'in', pay, { note: 'Salary' });

    const living = 176000 + Math.round(random() * 30000);
    add('acc_current', dayIn(month, 27), 'out', living, { note: 'Living costs' });

    // Lifetime ISA, capped at the 4,000 a year allowance.
    add('acc_lisa', dayIn(month, 3), 'in', 33300, { note: 'Monthly transfer' });
    // Stocks and shares ISA.
    add('acc_ssisa', dayIn(month, 4), 'in', 25000, { note: 'Monthly transfer' });
    // Savings.
    add('acc_savings', dayIn(month, 5), 'in', 15000 + Math.round(random() * 10000), {
      note: 'Monthly transfer'
    });

    // Debt repayment.
    if (!isCurrentMonth || random() > 0.5) {
      const owed = balance.get('acc_debt') || 0;
      const payment = Math.min(32000, owed);
      if (payment > 0) add('acc_debt', dayIn(month, 8), 'out', payment, { note: 'Monthly repayment' });
    }

    // Growth on the stocks and shares ISA, up most months and down some.
    const marketMove = Math.round((random() - 0.32) * 46000);
    if (marketMove !== 0) {
      add('acc_ssisa', dayIn(month, 28), marketMove > 0 ? 'in' : 'out', Math.abs(marketMove), {
        note: 'Market movement'
      });
    }

    // Crypto and metals purchases, not every month.
    if (random() > 0.45) {
      const price = priceFor('acc_bitcoin', i, MONTHS);
      const spend = 10000 + Math.round(random() * 15000);
      add('acc_bitcoin', dayIn(month, 12), 'in', spend, {
        unitsE8: unitsForPence(spend, price), unitPricePence: price, note: 'Monthly buy'
      });
    }
    if (random() > 0.6) {
      const price = priceFor('acc_ethereum', i, MONTHS);
      const spend = 6000 + Math.round(random() * 9000);
      add('acc_ethereum', dayIn(month, 14), 'in', spend, {
        unitsE8: unitsForPence(spend, price), unitPricePence: price, note: 'Monthly buy'
      });
    }
    // Buy Solana in the first two months for certain, then now and again,
    // so there is always a holding to take profit from later.
    if (i < 2 || random() > 0.7) {
      const price = priceFor('acc_solana', i, MONTHS);
      const spend = 4000 + Math.round(random() * 6000);
      add('acc_solana', dayIn(month, 16), 'in', spend, {
        unitsE8: unitsForPence(spend, price), unitPricePence: price, note: 'Monthly buy'
      });
    }
    if (random() > 0.8) {
      const price = priceFor('acc_silver', i, MONTHS);
      const ounces = 5 + Math.round(random() * 10);
      add('acc_silver', dayIn(month, 18), 'in', Math.round(ounces * price), {
        unitsE8: ounces * UNIT_SCALE, unitPricePence: price, note: 'Coin purchase'
      });
    }
    if (i === 4 || i === 9) {
      const price = priceFor('acc_gold', i, MONTHS);
      add('acc_gold', dayIn(month, 20), 'in', Math.round(0.5 * price), {
        unitsE8: Math.round(0.5 * UNIT_SCALE), unitPricePence: price, note: 'Half ounce purchase'
      });
    }

    // An occasional dip into savings.
    if (random() > 0.82) {
      const bill = 20000 + Math.round(random() * 40000);
      if ((balance.get('acc_savings') || 0) >= bill) {
        add('acc_savings', dayIn(month, 22), 'out', bill, { note: 'Unexpected bill' });
      }
    }
    // One sale, so the demo has a withdrawal from a quantity account.
    // Never sell more than is actually held, which is the same rule the
    // interface applies to a real withdrawal.
    if (i === 7) {
      const price = priceFor('acc_solana', i, MONTHS);
      const sellable = Math.floor((held.get('acc_solana') || 0) * 0.4);
      if (sellable > 0) {
        add('acc_solana', dayIn(month, 21), 'out', quantityValuePence(sellable, price), {
          unitsE8: sellable, unitPricePence: price, note: 'Took some profit'
        });
      }
    }
  }

  // Goals worth looking at.
  const withGoals = accounts.map((account) => {
    if (account.id === 'acc_lisa') {
      return {
        ...account,
        goal: {
          targetPence: 2000000,
          targetDate: addMonths(todayISO, 26),
          startDate: firstMonth,
          startPence: 640000
        }
      };
    }
    if (account.id === 'acc_savings') {
      return {
        ...account,
        goal: {
          targetPence: 600000,
          targetDate: addMonths(todayISO, 8),
          startDate: firstMonth,
          startPence: 210000
        }
      };
    }
    if (account.id === 'acc_ssisa') {
      return {
        ...account,
        goal: {
          targetPence: 2500000,
          targetDate: addMonths(todayISO, 40),
          startDate: firstMonth,
          startPence: 895000
        }
      };
    }
    if (account.id === 'acc_debt') {
      return {
        ...account,
        goal: {
          targetPence: 0,
          targetDate: addMonths(todayISO, 15),
          startDate: firstMonth,
          startPence: 480000
        }
      };
    }
    return account;
  });

  // Today's unit prices, marked as manually entered.
  const priced = withGoals.map((account) => {
    if (account.type !== 'quantity') return account;
    return {
      ...account,
      unitPricePence: priceTracks[account.id] ? priceTracks[account.id].end : account.unitPricePence,
      priceUpdatedAt: todayISO,
      priceSource: 'manual'
    };
  });

  const state = normaliseState({ accounts: priced, transactions }, todayISO);
  state.createdAt = firstMonth;
  return state;
}
