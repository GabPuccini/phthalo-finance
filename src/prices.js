/**
 * prices.js
 *
 * Optional live price lookup. Everything here is best effort.
 *
 * Manual entry is the source of truth. If a request fails for any reason
 * at all, offline, CORS, rate limit, a dead endpoint, a malformed
 * response or a timeout, the last manual price is kept exactly as it was
 * and the account is reported as stale. Nothing here can throw into the
 * rest of the app and the whole app works with the network permanently
 * unavailable.
 */

export const REQUEST_TIMEOUT_MS = 5000;

const CRYPTO_ENDPOINT = 'https://api.coingecko.com/api/v3/simple/price';
const METAL_ENDPOINT = 'https://api.gold-api.com/price';
const FX_ENDPOINT = 'https://api.frankfurter.app/latest';

/** Symbols the refresh knows how to look up, keyed by account id or name. */
export const KNOWN_SYMBOLS = {
  acc_bitcoin: { kind: 'crypto', id: 'bitcoin' },
  acc_ethereum: { kind: 'crypto', id: 'ethereum' },
  acc_solana: { kind: 'crypto', id: 'solana' },
  acc_gold: { kind: 'metal', id: 'XAU' },
  acc_silver: { kind: 'metal', id: 'XAG' }
};

const NAME_SYMBOLS = {
  bitcoin: { kind: 'crypto', id: 'bitcoin' },
  ethereum: { kind: 'crypto', id: 'ethereum' },
  solana: { kind: 'crypto', id: 'solana' },
  gold: { kind: 'metal', id: 'XAU' },
  silver: { kind: 'metal', id: 'XAG' }
};

/** Work out what to look up for an account, or null if it is not known. */
export function symbolFor(account) {
  if (!account || account.type !== 'quantity') return null;
  if (account.priceSymbol && account.priceKind) {
    return { kind: account.priceKind, id: account.priceSymbol };
  }
  if (KNOWN_SYMBOLS[account.id]) return KNOWN_SYMBOLS[account.id];
  const byName = NAME_SYMBOLS[String(account.name || '').trim().toLowerCase()];
  return byName || null;
}

/** fetch with a hard timeout that never rejects with anything unexpected. */
async function safeJson(url) {
  if (typeof fetch !== 'function') {
    return { ok: false, reason: 'This browser cannot fetch prices.' };
  }
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => { if (controller) controller.abort(); }, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller ? controller.signal : undefined,
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) {
      return { ok: false, reason: `The price service replied ${response.status}.` };
    }
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, reason: 'The price service sent something that was not JSON.' };
    }
    if (data === null || typeof data !== 'object') {
      return { ok: false, reason: 'The price service sent an unexpected reply.' };
    }
    return { ok: true, data };
  } catch (error) {
    const aborted = error && (error.name === 'AbortError' || error.name === 'TimeoutError');
    return {
      ok: false,
      reason: aborted
        ? `No reply within ${REQUEST_TIMEOUT_MS / 1000} seconds.`
        : 'Could not reach the price service.'
    };
  } finally {
    clearTimeout(timer);
  }
}

function toPence(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const pence = Math.round(value * 100);
  return pence > 0 ? pence : null;
}

/**
 * Look up prices for the given accounts.
 *
 * Always resolves. Returns:
 *   { prices: Map(accountId -> pence), failures: [{accountId, name, reason}],
 *     skipped: [{accountId, name}] }
 */
export async function fetchPrices(accounts) {
  const wanted = [];
  const skipped = [];
  for (const account of accounts) {
    if (account.type !== 'quantity' || account.archived) continue;
    const symbol = symbolFor(account);
    if (symbol) wanted.push({ account, symbol });
    else skipped.push({ accountId: account.id, name: account.name });
  }

  const prices = new Map();
  const failures = [];
  if (!wanted.length) return { prices, failures, skipped };

  const cryptoIds = [...new Set(wanted.filter((w) => w.symbol.kind === 'crypto').map((w) => w.symbol.id))];
  const metalIds = [...new Set(wanted.filter((w) => w.symbol.kind === 'metal').map((w) => w.symbol.id))];

  const jobs = [];

  if (cryptoIds.length) {
    jobs.push((async () => {
      const url = `${CRYPTO_ENDPOINT}?ids=${encodeURIComponent(cryptoIds.join(','))}&vs_currencies=gbp`;
      const result = await safeJson(url);
      if (!result.ok) {
        for (const w of wanted) {
          if (w.symbol.kind === 'crypto') {
            failures.push({ accountId: w.account.id, name: w.account.name, reason: result.reason });
          }
        }
        return;
      }
      for (const w of wanted) {
        if (w.symbol.kind !== 'crypto') continue;
        const entry = result.data[w.symbol.id];
        const pence = entry && typeof entry === 'object' ? toPence(entry.gbp) : null;
        if (pence) prices.set(w.account.id, pence);
        else {
          failures.push({
            accountId: w.account.id,
            name: w.account.name,
            reason: 'No price came back for that symbol.'
          });
        }
      }
    })());
  }

  if (metalIds.length) {
    jobs.push((async () => {
      // Metals come back in US dollars an ounce, so a rate is needed too.
      const [fx, ...metals] = await Promise.all([
        safeJson(`${FX_ENDPOINT}?from=USD&to=GBP`),
        ...metalIds.map((id) => safeJson(`${METAL_ENDPOINT}/${encodeURIComponent(id)}`))
      ]);

      const rate = fx.ok && fx.data && fx.data.rates && typeof fx.data.rates.GBP === 'number'
        ? fx.data.rates.GBP
        : null;

      metalIds.forEach((id, i) => {
        const affected = wanted.filter((w) => w.symbol.kind === 'metal' && w.symbol.id === id);
        const result = metals[i];
        if (!rate) {
          for (const w of affected) {
            failures.push({
              accountId: w.account.id,
              name: w.account.name,
              reason: fx.ok ? 'No dollar to pound rate came back.' : fx.reason
            });
          }
          return;
        }
        if (!result.ok) {
          for (const w of affected) {
            failures.push({ accountId: w.account.id, name: w.account.name, reason: result.reason });
          }
          return;
        }
        const usd = typeof result.data.price === 'number' ? result.data.price : null;
        const pence = usd === null ? null : toPence(usd * rate);
        for (const w of affected) {
          if (pence) prices.set(w.account.id, pence);
          else {
            failures.push({
              accountId: w.account.id,
              name: w.account.name,
              reason: 'No usable price came back for that metal.'
            });
          }
        }
      });
    })());
  }

  try {
    await Promise.all(jobs);
  } catch {
    // Nothing above rejects, but a surprise here must not break the app.
    for (const w of wanted) {
      if (!prices.has(w.account.id) && !failures.some((f) => f.accountId === w.account.id)) {
        failures.push({
          accountId: w.account.id,
          name: w.account.name,
          reason: 'The price refresh stopped unexpectedly.'
        });
      }
    }
  }

  return { prices, failures, skipped };
}

/** Plain English summary of what a refresh managed to do. */
export function describeResult(result) {
  const updated = result.prices.size;
  const failed = result.failures.length;
  const skipped = result.skipped.length;
  if (updated === 0 && failed === 0 && skipped === 0) return 'There are no unit prices to refresh.';
  const parts = [];
  if (updated) parts.push(`${updated} price${updated === 1 ? '' : 's'} updated`);
  if (failed) parts.push(`${failed} kept the last manual price`);
  if (skipped) parts.push(`${skipped} ${skipped === 1 ? 'has' : 'have'} no known symbol`);
  const reasons = [...new Set(result.failures.map((f) => f.reason))];
  const why = reasons.length ? ` ${reasons[0]}` : '';
  return `${parts.join(', ')}.${why}`;
}
