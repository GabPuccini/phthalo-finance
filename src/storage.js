/**
 * storage.js
 *
 * Everything that touches localStorage. No calculations live here.
 *
 * Three failure modes are handled explicitly, because all three happen in
 * real life on a phone:
 *
 *   1. Storage disabled, which is what private browsing does.
 *   2. Quota exceeded, once the ledger gets long.
 *   3. Corrupted or unparseable JSON, usually a half finished write.
 *
 * None of them are allowed to throw past this module or lose data. A
 * rolling backup of the last known good state is kept under a second key
 * so a bad write cannot destroy everything.
 */

import {
  BACKUP_KEY,
  STORAGE_KEY,
  SCHEMA_VERSION,
  dateToISO,
  migrate,
  validateImport
} from './logic.js';

export const STATUS = {
  OK: 'ok',
  FIRST_RUN: 'first-run',
  MIGRATED: 'migrated',
  CORRUPT: 'corrupt',
  RECOVERED: 'recovered',
  DISABLED: 'disabled'
};

/** Is localStorage actually usable right now? */
export function storageAvailable() {
  try {
    const probe = '__phthalo_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

function isQuotaError(error) {
  if (!error) return false;
  return error.name === 'QuotaExceededError'
    || error.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || error.code === 22
    || error.code === 1014;
}

function readRaw(key) {
  try {
    return { ok: true, value: window.localStorage.getItem(key) };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Load the saved state.
 *
 * Always returns a usable state object. The caller decides what to tell
 * the user based on `status` and `message`.
 */
export function load(todayISO = dateToISO(new Date())) {
  if (!storageAvailable()) {
    return {
      state: null,
      status: STATUS.DISABLED,
      message: 'This browser is not letting the app save anything, which usually means '
        + 'private browsing is switched on. You can still use the app, but nothing will '
        + 'be kept when you close the tab. Export a backup before you leave.',
      corruptRaw: null
    };
  }

  const primary = readRaw(STORAGE_KEY);
  if (!primary.ok) {
    return {
      state: null,
      status: STATUS.DISABLED,
      message: 'The saved data could not be read from this browser.',
      corruptRaw: null
    };
  }
  if (primary.value === null) {
    return { state: null, status: STATUS.FIRST_RUN, message: null, corruptRaw: null };
  }

  let parsed = null;
  let parseError = null;
  try {
    parsed = JSON.parse(primary.value);
  } catch (error) {
    parseError = error;
  }

  if (parseError || parsed === null || typeof parsed !== 'object') {
    // The main copy is unreadable. Try the rolling backup before giving up.
    const backup = readRaw(BACKUP_KEY);
    if (backup.ok && backup.value) {
      try {
        const recovered = JSON.parse(backup.value);
        const { state } = migrate(recovered, todayISO);
        return {
          state,
          status: STATUS.RECOVERED,
          message: 'The main saved copy was damaged and could not be read, so the app has '
            + 'loaded the rolling backup instead. You may have lost the most recent change. '
            + 'Please export a backup now.',
          corruptRaw: primary.value
        };
      } catch {
        // Both copies are gone. Fall through.
      }
    }
    return {
      state: null,
      status: STATUS.CORRUPT,
      message: 'The saved data is damaged and could not be read, and the rolling backup did '
        + 'not survive either. Nothing has been deleted. You can download the damaged file '
        + 'below to keep it, then start again.',
      corruptRaw: primary.value
    };
  }

  try {
    const { state, migratedFrom } = migrate(parsed, todayISO);
    if (migratedFrom !== null && migratedFrom !== undefined) {
      return {
        state,
        status: STATUS.MIGRATED,
        message: `Your saved data was upgraded from version ${migratedFrom} to version `
          + `${SCHEMA_VERSION}. Nothing was removed.`,
        corruptRaw: null
      };
    }
    return { state, status: STATUS.OK, message: null, corruptRaw: null };
  } catch (error) {
    return {
      state: null,
      status: STATUS.CORRUPT,
      message: `The saved data could not be upgraded to the current version (${error.message}). `
        + 'Nothing has been deleted. Download the file below to keep it.',
      corruptRaw: primary.value
    };
  }
}

/**
 * Save, keeping the previous good copy as a rolling backup.
 * Returns { ok, reason, message } and never throws.
 */
export function save(state) {
  if (!storageAvailable()) {
    return {
      ok: false,
      reason: 'disabled',
      message: 'Nothing can be saved because this browser is blocking storage. '
        + 'Private browsing is the usual cause. Export a backup to keep your data.'
    };
  }

  const payload = JSON.stringify(state);

  // Roll the current copy into the backup slot first. If this fails the
  // save still goes ahead, because a missing backup is better than a
  // missing save.
  try {
    const current = window.localStorage.getItem(STORAGE_KEY);
    if (current) window.localStorage.setItem(BACKUP_KEY, current);
  } catch (error) {
    if (isQuotaError(error)) {
      try { window.localStorage.removeItem(BACKUP_KEY); } catch { /* nothing to do */ }
    }
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, payload);
    return { ok: true, reason: null, message: null };
  } catch (error) {
    if (isQuotaError(error)) {
      // Free the backup and try once more. Losing the backup is a smaller
      // loss than losing the change the user just made.
      try {
        window.localStorage.removeItem(BACKUP_KEY);
        window.localStorage.setItem(STORAGE_KEY, payload);
        return {
          ok: true,
          reason: 'quota-recovered',
          message: 'Storage was full, so the rolling backup was cleared to make room. '
            + 'Your change was saved. Export a backup and consider deleting old entries.'
        };
      } catch {
        return {
          ok: false,
          reason: 'quota',
          message: 'This browser has run out of storage space, so your last change could not '
            + 'be saved. Export a backup now, then delete some old transactions to make room.'
        };
      }
    }
    return {
      ok: false,
      reason: 'unknown',
      message: `Your last change could not be saved (${error.name || 'unknown error'}). `
        + 'Export a backup now so nothing is lost.'
    };
  }
}

/** Remove everything this app has stored. Used by "Clear all data". */
export function clearAll() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
    window.localStorage.removeItem(BACKUP_KEY);
    return { ok: true };
  } catch {
    return { ok: false, message: 'The saved data could not be removed from this browser.' };
  }
}

/** The raw stored text, for the recovery screen download. */
export function rawSnapshot() {
  const primary = readRaw(STORAGE_KEY);
  const backup = readRaw(BACKUP_KEY);
  return {
    primary: primary.ok ? primary.value : null,
    backup: backup.ok ? backup.value : null
  };
}

/* ------------------------------------------------------------------ */
/* Export and import                                                   */
/* ------------------------------------------------------------------ */

export function exportFilename(todayISO, extension) {
  return `phthalo-finance-${todayISO}.${extension}`;
}

export function toExportJson(state) {
  return JSON.stringify(state, null, 2);
}

/**
 * Read an imported file. Validates before anything is loaded, so a bad
 * file is refused outright rather than half applied.
 */
export function parseImport(text, todayISO = dateToISO(new Date())) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, errors: ['The file is empty.'], state: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      errors: [`That is not a valid JSON file (${error.message}).`],
      state: null
    };
  }

  const check = validateImport(parsed);
  if (!check.ok) return { ok: false, errors: check.errors, state: null };

  try {
    const { state } = migrate(parsed, todayISO);
    return { ok: true, errors: [], state };
  } catch (error) {
    return {
      ok: false,
      errors: [`The file is the right shape but could not be loaded (${error.message}).`],
      state: null
    };
  }
}

/** Trigger a download. The only place this module touches the document. */
export function downloadText(filename, text, mimeType) {
  try {
    const blob = new Blob([text], { type: `${mimeType};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    // Give the browser a moment to start the download before revoking.
    window.setTimeout(() => URL.revokeObjectURL(url), 10000);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: `The download could not be started (${error.message}).` };
  }
}

/** Days since the last export, or null if there has never been one. */
export function daysSinceExport(state, todayISO) {
  if (!state || !state.lastExportAt) return null;
  try {
    const then = new Date(`${state.lastExportAt}T00:00:00Z`).getTime();
    const now = new Date(`${todayISO}T00:00:00Z`).getTime();
    return Math.round((now - then) / 86400000);
  } catch {
    return null;
  }
}
