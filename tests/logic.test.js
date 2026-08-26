/**
 * logic.test.js
 *
 * The Node runner. Needs nothing installed:
 *
 *     node --test
 *
 * The assertions live in cases.js so that tests.html can run the same ones
 * in the browser.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { cases, useAssert } from './cases.js';

useAssert(assert);

for (const testCase of cases) {
  test(testCase.name, testCase.fn);
}
