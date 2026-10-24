/**
 * stamp-sw.mjs
 *
 * Sets CACHE_VERSION in sw.js from a hash of every file the service worker
 * caches. Run it before every deploy:
 *
 *     node tools/stamp-sw.mjs
 *
 * Changing sw.js is what makes a phone notice a new release, so a release
 * that forgets to change it is served from the old cache indefinitely.
 * Deriving the version from the files means it changes exactly when they
 * do, and `node --test` fails if they have changed since the last stamp.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function precacheList(swSource) {
  const block = swSource.slice(swSource.indexOf('const PRECACHE = ['), swSource.indexOf('];', swSource.indexOf('const PRECACHE = [')));
  return [...block.matchAll(/'(\.\/[^']*)'/g)].map((m) => m[1]);
}

export function contentHash(root = ROOT) {
  const sw = readFileSync(path.join(root, 'sw.js'), 'utf8');
  const hash = createHash('sha256');
  for (const entry of precacheList(sw)) {
    if (entry === './') continue;
    hash.update(entry);
    hash.update(readFileSync(path.join(root, entry.slice(2))));
  }
  // The worker's own logic counts too, everything but the version line.
  hash.update(sw.replace(/const CACHE_VERSION = '[^']*';/, ''));
  return hash.digest('hex').slice(0, 12);
}

export function stampedVersion(swSource) {
  const match = swSource.match(/const CACHE_VERSION = '([^']*)';/);
  return match ? match[1] : null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const file = path.join(ROOT, 'sw.js');
  const sw = readFileSync(file, 'utf8');
  const next = contentHash();
  const current = stampedVersion(sw);
  if (current === next) {
    console.log(`CACHE_VERSION is already ${next}. Nothing has changed since the last stamp.`);
  } else {
    writeFileSync(file, sw.replace(/const CACHE_VERSION = '[^']*';/, `const CACHE_VERSION = '${next}';`));
    console.log(`CACHE_VERSION ${current} -> ${next}`);
  }
}
