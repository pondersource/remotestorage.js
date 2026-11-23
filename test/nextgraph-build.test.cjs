const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const patch = require('../scripts/nextgraph-csp-loader.cjs');

test('the CSP compatibility patch accepts only the audited SDK bytes', () => {
  const source = readFileSync(require.resolve('@ng-org/web'), 'utf8');
  const result = patch(source);
  assert.notEqual(result, source);
  assert.ok(result.includes('function i(){return function(){}}'));
  assert.ok(!result.includes('class i extends Function{}'));
  assert.throws(() => patch(source + '\n'), /requires the audited/);
  assert.throws(() => patch(source.replace('class i extends Function{}', 'class j extends Function{}')), /requires the audited/);
});
