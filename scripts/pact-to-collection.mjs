#!/usr/bin/env node
// Convert a Pact contract (specification 2.x or 3.x JSON) into a Postman
// collection whose tests assert only what the consumer relies on.
// Deterministic JSON-in/JSON-out: the same pact bytes always produce the same
// collection bytes — no timestamps, no random IDs.
//
//   node scripts/pact-to-collection.mjs \
//     --pact <consumer-provider.pact.json> \
//     --out <collection.postman_collection.json>
//
// Mapping:
//   - One pact interaction -> one collection item hitting {{baseUrl}} + path.
//   - response.status      -> exact status assertion.
//   - response.headers     -> per-header assertion (equality, or regex/type
//                             when a matching rule covers the header).
//   - response.body leaves -> one assertion per leaf the consumer declared:
//                             type check when a `match: type` rule covers the
//                             leaf, regex check for `match: regex`, exact
//                             equality otherwise. Nothing outside the declared
//                             body is asserted — extra provider fields pass.
//   - providerState(s)     -> documented on the item description and reported
//                             as warnings; state setup is NOT automated (the
//                             known gap versus Pact provider states).
// Pact specification 4.x is rejected explicitly rather than half-converted.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

export function pactSpecVersion(pact) {
  const meta = pact.metadata ?? {};
  const raw = meta.pactSpecification?.version
    ?? meta['pact-specification']?.version
    ?? meta.pactSpecificationVersion
    ?? '';
  return String(raw);
}

// Normalize v2 ("$.body.a[0].b" at interaction.response.matchingRules) and v3
// ({ body: { "$.a[0].b": { matchers: [...] } } }) into one flat shape:
//   { body: Map<path, rule>, header: Map<lowercase-name, rule> }
// where rule = { match: 'type'|'regex'|..., regex?, min? }.
export function normalizeMatchingRules(response) {
  const body = new Map();
  const header = new Map();
  const raw = response?.matchingRules;
  if (!raw || typeof raw !== 'object') return { body, header };

  const firstMatcher = (value) => {
    if (Array.isArray(value?.matchers) && value.matchers.length > 0) return value.matchers[0];
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    return null;
  };

  if (raw.body || raw.header || raw.headers || raw.status) {
    for (const [path, value] of Object.entries(raw.body ?? {})) {
      const m = firstMatcher(value);
      if (m) body.set(path, m);
    }
    for (const [name, value] of Object.entries(raw.header ?? raw.headers ?? {})) {
      const m = firstMatcher(value);
      if (m) header.set(name.toLowerCase(), m);
    }
    return { body, header };
  }

  for (const [path, value] of Object.entries(raw)) {
    const m = firstMatcher(value);
    if (!m) continue;
    if (path.startsWith('$.body')) {
      const rest = path.slice('$.body'.length);
      body.set(rest.length === 0 ? '$' : `$${rest}`, m);
    } else if (path.startsWith('$.headers.')) {
      header.set(path.slice('$.headers.'.length).toLowerCase(), m);
    }
  }
  return { body, header };
}

// Enumerate the leaves of the expected body as [{ jsonPath, lodashPath, value }].
// Objects/arrays with no children still produce a leaf so empty shapes assert.
export function flattenLeaves(value, jsonPath = '$', lodashPath = '') {
  if (Array.isArray(value)) {
    if (value.length === 0) return [{ jsonPath, lodashPath, value }];
    return value.flatMap((entry, index) => flattenLeaves(
      entry,
      `${jsonPath}[${index}]`,
      lodashPath ? `${lodashPath}[${index}]` : `[${index}]`,
    ));
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return [{ jsonPath, lodashPath, value }];
    return entries.flatMap(([key, entry]) => flattenLeaves(
      entry,
      `${jsonPath}.${key}`,
      lodashPath ? `${lodashPath}.${key}` : key,
    ));
  }
  return [{ jsonPath, lodashPath, value }];
}

// Find the most specific matching rule for a concrete leaf path: exact path,
// the path with indices wildcarded, then each ancestor (exact and wildcarded).
export function lookupRule(bodyRules, jsonPath) {
  const wildcard = (p) => p.replace(/\[\d+\]/g, '[*]');
  const candidates = [];
  let current = jsonPath;
  for (;;) {
    candidates.push(current, wildcard(current));
    const cut = Math.max(current.lastIndexOf('.'), current.lastIndexOf('['));
    if (cut <= 0) break;
    current = current.slice(0, cut);
  }
  candidates.push('$');
  for (const key of candidates) {
    if (bodyRules.has(key)) return bodyRules.get(key);
  }
  return null;
}

// Resolve a lodash-style path ("a.b[0].c") against a plain object without
// depending on lodash in the generator itself.
export function resolvePath(value, lodashPath) {
  if (lodashPath === '') return value;
  const tokens = lodashPath.match(/[^.[\]]+/g) ?? [];
  let current = value;
  for (const token of tokens) {
    if (current === null || typeof current !== 'object') return undefined;
    current = current[token];
  }
  return current;
}

function jsType(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function assertionFor(leaf, rule) {
  const path = JSON.stringify(leaf.lodashPath);
  const label = leaf.jsonPath;
  if (rule && rule.match === 'type' && leaf.value !== null) {
    const type = jsType(leaf.value);
    if (type === 'array') {
      const min = Number.isInteger(rule.min) ? rule.min : null;
      const lengthCheck = min === null ? '' : ` pm.expect(_.get(body, ${path}).length).to.be.at.least(${min});`;
      return `pm.test(${JSON.stringify(`body ${label} is an array`)}, function () { pm.expect(Array.isArray(_.get(body, ${path}))).to.eql(true);${lengthCheck} });`;
    }
    return `pm.test(${JSON.stringify(`body ${label} matches type ${type}`)}, function () { pm.expect(typeof _.get(body, ${path})).to.eql(${JSON.stringify(type)}); });`;
  }
  if (rule && rule.match === 'regex' && typeof rule.regex === 'string') {
    return `pm.test(${JSON.stringify(`body ${label} matches ${rule.regex}`)}, function () { pm.expect(String(_.get(body, ${path}))).to.match(new RegExp(${JSON.stringify(rule.regex)})); });`;
  }
  return `pm.test(${JSON.stringify(`body ${label} equals expected`)}, function () { pm.expect(_.get(body, ${path})).to.eql(${JSON.stringify(leaf.value)}); });`;
}

export function buildTestScript(response) {
  const rules = normalizeMatchingRules(response);
  const lines = [
    "const _ = require('lodash');",
    `pm.test(${JSON.stringify(`status is ${response.status}`)}, function () { pm.response.to.have.status(${Number(response.status)}); });`,
  ];
  for (const [name, expected] of Object.entries(response.headers ?? {})) {
    const rule = rules.header.get(name.toLowerCase());
    if (rule && rule.match === 'regex' && typeof rule.regex === 'string') {
      lines.push(`pm.test(${JSON.stringify(`header ${name} matches ${rule.regex}`)}, function () { pm.expect(String(pm.response.headers.get(${JSON.stringify(name)}))).to.match(new RegExp(${JSON.stringify(rule.regex)})); });`);
    } else if (rule && rule.match === 'type') {
      lines.push(`pm.test(${JSON.stringify(`header ${name} is present`)}, function () { pm.response.to.have.header(${JSON.stringify(name)}); });`);
    } else {
      lines.push(`pm.test(${JSON.stringify(`header ${name} equals expected`)}, function () { pm.expect(String(pm.response.headers.get(${JSON.stringify(name)}))).to.eql(${JSON.stringify(String(expected))}); });`);
    }
  }
  if (response.body !== undefined) {
    lines.push('const body = pm.response.json();');
    // Container assertions first: a `match: type` rule aimed at an array node
    // (e.g. "$.links" with min) must assert the array itself; leaf flattening
    // below only sees the array's elements.
    for (const [rulePath, rule] of [...rules.body.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (rule.match !== 'type' || rulePath === '$' || rulePath.includes('[*]')) continue;
      const lodashPath = rulePath.startsWith('$.') ? rulePath.slice(2) : rulePath;
      const target = resolvePath(response.body, lodashPath);
      if (!Array.isArray(target) || target.length === 0) continue;
      lines.push(assertionFor({ jsonPath: rulePath, lodashPath, value: target }, rule));
    }
    const leaves = flattenLeaves(response.body);
    for (const leaf of leaves) {
      if (leaf.lodashPath === '') {
        lines.push(`pm.test('body equals expected', function () { pm.expect(body).to.eql(${JSON.stringify(response.body)}); });`);
        continue;
      }
      lines.push(assertionFor(leaf, lookupRule(rules.body, leaf.jsonPath)));
    }
  }
  return lines;
}

function buildQuery(query) {
  if (!query) return [];
  if (typeof query === 'string') {
    return query.split('&').filter(Boolean).map((pair) => {
      const eq = pair.indexOf('=');
      return eq >= 0
        ? { key: decodeURIComponent(pair.slice(0, eq)), value: decodeURIComponent(pair.slice(eq + 1)) }
        : { key: decodeURIComponent(pair), value: '' };
    });
  }
  return Object.entries(query).flatMap(([key, value]) => (Array.isArray(value)
    ? value.map((v) => ({ key, value: String(v) }))
    : [{ key, value: String(value) }]));
}

export function providerStatesOf(interaction) {
  if (Array.isArray(interaction.providerStates)) {
    return interaction.providerStates.map((state) => state?.name).filter(Boolean);
  }
  if (typeof interaction.providerState === 'string' && interaction.providerState) {
    return [interaction.providerState];
  }
  return [];
}

export function interactionToItem(interaction) {
  const request = interaction.request ?? {};
  const path = String(request.path ?? '/');
  const states = providerStatesOf(interaction);
  const descriptionParts = [];
  if (states.length > 0) {
    descriptionParts.push(`Provider state (manual/seeded, not automated): ${states.join('; ')}`);
  }
  const item = {
    name: String(interaction.description ?? `${request.method ?? 'GET'} ${path}`),
    event: [{
      listen: 'test',
      script: { type: 'text/javascript', exec: buildTestScript(interaction.response ?? { status: 200 }) },
    }],
    request: {
      method: String(request.method ?? 'GET').toUpperCase(),
      header: Object.entries(request.headers ?? {}).map(([key, value]) => ({ key, value: String(value) })),
      url: {
        raw: `{{baseUrl}}${path}`,
        host: ['{{baseUrl}}'],
        path: path.split('/').filter(Boolean),
        query: buildQuery(request.query),
      },
    },
  };
  if (descriptionParts.length > 0) item.description = descriptionParts.join('\n');
  if (request.body !== undefined) {
    item.request.body = {
      mode: 'raw',
      raw: JSON.stringify(request.body, null, 2),
      options: { raw: { language: 'json' } },
    };
  }
  return item;
}

function deterministicId(seed) {
  const hex = createHash('sha256').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function convertPact(pact) {
  const version = pactSpecVersion(pact);
  if (version.startsWith('4')) {
    throw new Error('Pact specification 4.x is not supported yet; export the contract as specification 2.x or 3.x.');
  }
  const consumer = String(pact.consumer?.name ?? 'unknown-consumer');
  const provider = String(pact.provider?.name ?? 'unknown-provider');
  const interactions = pact.interactions;
  if (!Array.isArray(interactions) || interactions.length === 0) {
    throw new Error('Pact contract has no interactions.');
  }
  const warnings = [];
  const items = interactions.map((interaction) => {
    const states = providerStatesOf(interaction);
    if (states.length > 0) {
      warnings.push(`Interaction "${interaction.description}" requires provider state: ${states.join('; ')} — seed it before the run; state setup is not automated.`);
    }
    return interactionToItem(interaction);
  });
  const collection = {
    info: {
      _postman_id: deterministicId(`${consumer}\n${provider}`),
      name: `Consumer contract — ${consumer} → ${provider}`,
      description: `Generated deterministically from the ${consumer} consumer contract (pact specification ${version || 'unversioned'}). Assertions cover only what the consumer relies on; extra provider fields do not fail.`,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: items,
    variable: [{ key: 'baseUrl', value: 'http://localhost:8080', type: 'string' }],
  };
  return { collection, consumer, provider, warnings };
}

function main() {
  const pactPath = arg('pact');
  const outPath = arg('out');
  if (!pactPath || !outPath) {
    console.error('Usage: pact-to-collection.mjs --pact <pact.json> --out <collection.json>');
    process.exit(2);
  }
  const pact = JSON.parse(readFileSync(pactPath, 'utf8'));
  const { collection, consumer, provider, warnings } = convertPact(pact);
  writeFileSync(outPath, `${JSON.stringify(collection, null, 2)}\n`);
  for (const warning of warnings) console.error(`WARN: ${warning}`);
  console.log(`Converted ${consumer} → ${provider}: ${collection.item.length} interaction(s) -> ${outPath}`);
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) main();
