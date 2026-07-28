import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyLedger, recordResult, checkDeploy } from '../scripts/can-i-deploy.mjs';

const entry = (overrides = {}) => ({
  providerVersion: 'abc123',
  consumer: 'checkout-web',
  contractSha256: 'sha-1',
  status: 'passed',
  ...overrides,
});

test('recording is an idempotent upsert with deterministic ordering', () => {
  let ledger = emptyLedger('orders-service');
  ledger = recordResult(ledger, entry({ consumer: 'mobile-app' }));
  ledger = recordResult(ledger, entry());
  const again = recordResult(ledger, entry());
  assert.deepEqual(again, ledger); // same key, same status -> byte-identical
  assert.deepEqual(ledger.results.map((r) => r.consumer), ['checkout-web', 'mobile-app']);
});

test('re-recording a failed verification as passed replaces the entry', () => {
  let ledger = emptyLedger('orders-service');
  ledger = recordResult(ledger, entry({ status: 'failed' }));
  assert.equal(checkDeploy(ledger, 'abc123').ok, false);
  ledger = recordResult(ledger, entry({ status: 'passed' }));
  assert.equal(ledger.results.length, 1);
  assert.equal(checkDeploy(ledger, 'abc123').ok, true);
});

test('check fails when any required consumer is failed or unverified', () => {
  let ledger = emptyLedger('orders-service');
  ledger = recordResult(ledger, entry());
  ledger = recordResult(ledger, entry({ consumer: 'mobile-app', status: 'failed' }));
  const verdict = checkDeploy(ledger, 'abc123');
  assert.equal(verdict.ok, false);
  assert.deepEqual(
    verdict.perConsumer.map((c) => [c.consumer, c.status]),
    [['checkout-web', 'passed'], ['mobile-app', 'failed']],
  );

  // A consumer verified against an older provider version is unverified here.
  const older = checkDeploy(ledger, 'def456');
  assert.equal(older.ok, false);
  assert.equal(older.perConsumer[0].status, 'unverified');
});

test('explicit consumer list narrows the gate; empty ledger never passes', () => {
  let ledger = emptyLedger('orders-service');
  ledger = recordResult(ledger, entry());
  ledger = recordResult(ledger, entry({ consumer: 'mobile-app', status: 'failed' }));
  assert.equal(checkDeploy(ledger, 'abc123', ['checkout-web']).ok, true);
  assert.equal(checkDeploy(emptyLedger('orders-service'), 'abc123').ok, false);
});

test('rejects malformed entries and unknown statuses', () => {
  assert.throws(() => recordResult(emptyLedger('p'), entry({ consumer: '' })), /required field "consumer"/);
  assert.throws(() => recordResult(emptyLedger('p'), entry({ status: 'flaky' })), /must be one of/);
});
