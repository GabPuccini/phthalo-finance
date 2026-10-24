/**
 * logic.test.js
 *
 * The Node runner. Needs nothing installed:
 *
 *     node --test
 *
 * The assertions live in cases.js so that tests.html can run the same ones
 * in the browser. The one check below needs the file system, so it lives
 * here and runs under Node only.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { cases, useAssert } from './cases.js';
import * as L from '../src/logic.js';

useAssert(assert);

for (const testCase of cases) {
  test(testCase.name, testCase.fn);
}

/** Read one theme block of styles.css into a map of custom properties. */
function themeBlock(css, selector) {
  const at = css.indexOf(selector);
  assert.ok(at >= 0, `styles.css has no ${selector} block`);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  const props = new Map();
  for (const match of css.slice(open + 1, close).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    props.set(match[1], match[2].trim().toUpperCase());
  }
  return props;
}

const kebab = (key) => `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

test('styles.css ships exactly the colours that were measured', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  const blocks = {
    dark: themeBlock(css, ':root,\n:root[data-theme="dark"]'),
    light: themeBlock(css, ':root[data-theme="light"]')
  };

  for (const theme of ['dark', 'light']) {
    const props = blocks[theme];
    for (const [key, hex] of Object.entries(L.THEME_COLOURS[theme])) {
      assert.equal(props.get(kebab(key)), hex.toUpperCase(),
        `${theme}: ${kebab(key)} in styles.css differs from THEME_COLOURS.${key}`);
    }
    for (const [category, hex] of Object.entries(L.CATEGORY_COLOURS[theme])) {
      const name = `--cat-${L.categoryKey(category)}`;
      assert.equal(props.get(name), hex.toUpperCase(),
        `${theme}: ${name} in styles.css differs from CATEGORY_COLOURS`);
      assert.equal(props.get(`${name}-ink`), L.readableTextOn(hex).toUpperCase(),
        `${theme}: ${name}-ink is not the readable glyph colour for that fill`);
    }
  }
});

test('the service worker caches every file the app needs, and nothing missing', async () => {
  const { precacheList } = await import('../tools/stamp-sw.mjs');
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  const list = precacheList(sw);
  for (const entry of list) {
    if (entry === './') continue;
    assert.ok(existsSync(new URL(`../${entry.slice(2)}`, import.meta.url)), `sw.js caches ${entry}, which does not exist`);
  }
  // Every module reachable from the page must be cached, or offline breaks.
  const modules = new Set(['./src/app.js']);
  for (const file of readdirSync(new URL('../src/', import.meta.url))) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    for (const m of source.matchAll(/from '\.\/([a-z]+\.js)'/g)) modules.add(`./src/${m[1]}`);
  }
  for (const module of modules) assert.ok(list.includes(module), `${module} is imported but not cached for offline use`);
  for (const file of ['./index.html', './styles.css', './manifest.json']) assert.ok(list.includes(file), `${file} is not cached`);
});

test('CACHE_VERSION has been stamped since the cached files last changed', async () => {
  // If this fails, run: node tools/stamp-sw.mjs
  // A release whose sw.js does not change is never noticed by an installed
  // copy, which then serves the old files from its cache indefinitely.
  const { contentHash, stampedVersion } = await import('../tools/stamp-sw.mjs');
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  assert.equal(stampedVersion(sw), contentHash(),
    'files changed since CACHE_VERSION was stamped. Run: node tools/stamp-sw.mjs');
});
