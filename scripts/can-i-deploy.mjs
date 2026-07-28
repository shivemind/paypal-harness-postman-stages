#!/usr/bin/env node
// Deterministic consumer-verification ledger and deploy gate — the minimal
// Pact-broker/can-i-deploy analogue for the consumer-contract stage.
// Same inputs always produce the same ledger bytes and the same verdict:
// entries carry no timestamps; re-recording the same key replaces the entry.
//
// Record one verification result (idempotent upsert on
// provider-version + consumer + contract digest):
//   node scripts/can-i-deploy.mjs record --ledger <ledger.json> \
//     --provider <name> --provider-version <sha> \
//     --consumer <name> --contract-sha <sha256-of-pact-file> \
//     --result passed|failed
//
// Gate a deploy of one provider version:
//   node scripts/can-i-deploy.mjs check --ledger <ledger.json> \
//     --provider-version <sha> [--consumers a,b] [--json-out <report.json>]
//
// Check semantics: every required consumer (the --consumers list, or every
// consumer present in the ledger) must have at least one recorded verification
// for that provider version, and none of its recorded verifications for that
// version may be failed. A failed contract blocks until the same key is
// re-recorded as passed after a fix.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const SCHEMA_VERSION = 1;
const RESULTS = new Set(['passed', 'failed']);

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

export function emptyLedger(provider) {
  return { schemaVersion: SCHEMA_VERSION, provider: String(provider), results: [] };
}

export function loadLedger(path, provider) {
  if (!existsSync(path)) return emptyLedger(provider);
  const ledger = JSON.parse(readFileSync(path, 'utf8'));
  if (ledger.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported ledger schemaVersion ${ledger.schemaVersion}; expected ${SCHEMA_VERSION}.`);
  }
  return ledger;
}

export function recordResult(ledger, entry) {
  for (const field of ['providerVersion', 'consumer', 'contractSha256', 'status']) {
    if (!entry[field] || typeof entry[field] !== 'string') {
      throw new Error(`Verification entry is missing required field "${field}".`);
    }
  }
  if (!RESULTS.has(entry.status)) {
    throw new Error(`Verification status must be one of ${[...RESULTS].join('|')}, got "${entry.status}".`);
  }
  const key = (e) => `${e.providerVersion}\n${e.consumer}\n${e.contractSha256}`;
  const next = ledger.results.filter((existing) => key(existing) !== key(entry));
  next.push({
    providerVersion: entry.providerVersion,
    consumer: entry.consumer,
    contractSha256: entry.contractSha256,
    status: entry.status,
  });
  next.sort((a, b) => key(a).localeCompare(key(b)));
  return { ...ledger, results: next };
}

export function checkDeploy(ledger, providerVersion, requiredConsumers = null) {
  const forVersion = ledger.results.filter((e) => e.providerVersion === providerVersion);
  const allConsumers = [...new Set(ledger.results.map((e) => e.consumer))].sort();
  const required = (requiredConsumers && requiredConsumers.length > 0
    ? [...requiredConsumers]
    : allConsumers).sort();
  const perConsumer = required.map((consumer) => {
    const entries = forVersion.filter((e) => e.consumer === consumer);
    const failed = entries.filter((e) => e.status === 'failed').map((e) => e.contractSha256);
    const passed = entries.filter((e) => e.status === 'passed').map((e) => e.contractSha256);
    let status;
    if (entries.length === 0) status = 'unverified';
    else if (failed.length > 0) status = 'failed';
    else status = 'passed';
    return { consumer, status, passed, failed };
  });
  const ok = required.length > 0 && perConsumer.every((c) => c.status === 'passed');
  return { ok, providerVersion, required, perConsumer };
}

function main() {
  const mode = process.argv[2];
  const ledgerPath = arg('ledger');
  if (!ledgerPath || (mode !== 'record' && mode !== 'check')) {
    console.error('Usage: can-i-deploy.mjs record|check --ledger <ledger.json> ...');
    process.exit(2);
  }

  if (mode === 'record') {
    const provider = arg('provider', 'unknown-provider');
    const ledger = loadLedger(ledgerPath, provider);
    const updated = recordResult(ledger, {
      providerVersion: arg('provider-version', ''),
      consumer: arg('consumer', ''),
      contractSha256: arg('contract-sha', ''),
      status: arg('result', ''),
    });
    writeFileSync(ledgerPath, `${JSON.stringify(updated, null, 2)}\n`);
    console.log(`recorded ${arg('consumer')} @ ${arg('provider-version')}: ${arg('result')}`);
    return;
  }

  const ledger = loadLedger(ledgerPath, arg('provider', 'unknown-provider'));
  const consumersArg = arg('consumers', '');
  const required = consumersArg ? consumersArg.split(',').map((s) => s.trim()).filter(Boolean) : null;
  const verdict = checkDeploy(ledger, arg('provider-version', ''), required);
  if (arg('json-out')) writeFileSync(arg('json-out'), `${JSON.stringify(verdict, null, 2)}\n`);
  for (const consumer of verdict.perConsumer) {
    console.log(`  ${consumer.status.toUpperCase().padEnd(10)} ${consumer.consumer}`);
  }
  console.log(`can-i-deploy ${verdict.providerVersion}: ${verdict.ok ? 'YES' : 'NO'}`);
  if (!verdict.ok) process.exit(1);
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) main();
