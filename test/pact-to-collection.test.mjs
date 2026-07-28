import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pactSpecVersion,
  normalizeMatchingRules,
  flattenLeaves,
  lookupRule,
  buildTestScript,
  interactionToItem,
  convertPact,
} from '../scripts/pact-to-collection.mjs';

const v3Pact = {
  consumer: { name: 'checkout-web' },
  provider: { name: 'orders-service' },
  metadata: { pactSpecification: { version: '3.0.0' } },
  interactions: [
    {
      description: 'get an order by id',
      providerStates: [{ name: 'order 42 exists' }],
      request: {
        method: 'GET',
        path: '/api/orders/42',
        query: { expand: 'items' },
        headers: { Accept: 'application/json' },
      },
      response: {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: { id: 42, status: 'CREATED', links: [{ rel: 'self' }] },
        matchingRules: {
          body: {
            '$.id': { matchers: [{ match: 'type' }] },
            '$.links': { matchers: [{ match: 'type', min: 1 }] },
            '$.links[*].rel': { matchers: [{ match: 'regex', regex: '^(self|approve)$' }] },
          },
        },
      },
    },
    {
      description: 'create an order',
      request: {
        method: 'POST',
        path: '/api/orders',
        headers: { 'Content-Type': 'application/json' },
        body: { intent: 'CAPTURE' },
      },
      response: { status: 201, body: { status: 'CREATED' } },
    },
  ],
};

test('detects pact specification versions in v2 and v3 metadata shapes', () => {
  assert.equal(pactSpecVersion(v3Pact), '3.0.0');
  assert.equal(pactSpecVersion({ metadata: { 'pact-specification': { version: '2.0.0' } } }), '2.0.0');
  assert.equal(pactSpecVersion({}), '');
});

test('normalizes v2 dollar-body rules and v3 categorized rules to one shape', () => {
  const v3 = normalizeMatchingRules(v3Pact.interactions[0].response);
  assert.equal(v3.body.get('$.id').match, 'type');
  assert.equal(v3.body.get('$.links[*].rel').regex, '^(self|approve)$');

  const v2 = normalizeMatchingRules({
    matchingRules: {
      '$.body.id': { match: 'type' },
      '$.headers.Content-Type': { match: 'regex', regex: 'json' },
    },
  });
  assert.equal(v2.body.get('$.id').match, 'type');
  assert.equal(v2.header.get('content-type').regex, 'json');
});

test('flattens body leaves with jsonpath and lodash paths', () => {
  const leaves = flattenLeaves({ a: { b: [1, 2] }, c: 'x' });
  assert.deepEqual(leaves.map((l) => l.jsonPath), ['$.a.b[0]', '$.a.b[1]', '$.c']);
  assert.deepEqual(leaves.map((l) => l.lodashPath), ['a.b[0]', 'a.b[1]', 'c']);
});

test('rule lookup prefers exact, then wildcard index, then ancestors', () => {
  const rules = new Map([
    ['$.links[*].rel', { match: 'regex', regex: 'self' }],
    ['$.links', { match: 'type', min: 1 }],
  ]);
  assert.equal(lookupRule(rules, '$.links[0].rel').regex, 'self');
  assert.equal(lookupRule(rules, '$.links[3]').match, 'type');
  assert.equal(lookupRule(rules, '$.other'), null);
});

test('generated tests assert status, headers, and only consumer-declared body fields', () => {
  const script = buildTestScript(v3Pact.interactions[0].response).join('\n');
  assert.match(script, /pm\.response\.to\.have\.status\(200\)/);
  assert.match(script, /typeof _\.get\(body, "id"\)/); // type rule -> typeof, not equality
  assert.match(script, /"body \$\.status equals expected"/); // no rule -> equality
  assert.match(script, /Array\.isArray\(_\.get\(body, "links"\)\)/);
  assert.match(script, /new RegExp\("\^\(self\|approve\)\$"\)/);
  assert.doesNotMatch(script, /create_time/); // nothing asserted beyond the contract
});

test('interaction maps to a runnable collection item against {{baseUrl}}', () => {
  const item = interactionToItem(v3Pact.interactions[0]);
  assert.equal(item.request.method, 'GET');
  assert.equal(item.request.url.raw, '{{baseUrl}}/api/orders/42');
  assert.deepEqual(item.request.url.query, [{ key: 'expand', value: 'items' }]);
  assert.match(item.description, /order 42 exists/);
  const post = interactionToItem(v3Pact.interactions[1]);
  assert.equal(post.request.body.mode, 'raw');
  assert.match(post.request.body.raw, /"intent": "CAPTURE"/);
});

test('conversion is deterministic and surfaces provider states as warnings', () => {
  const first = convertPact(v3Pact);
  const second = convertPact(v3Pact);
  assert.equal(JSON.stringify(first.collection), JSON.stringify(second.collection));
  assert.equal(first.collection.info.name, 'Consumer contract — checkout-web → orders-service');
  assert.equal(first.collection.item.length, 2);
  assert.equal(first.warnings.length, 1);
  assert.match(first.warnings[0], /order 42 exists/);
});

test('rejects v4 message interactions and empty contracts explicitly', () => {
  assert.throws(
    () => convertPact({
      metadata: { pactSpecification: { version: '4.0' } },
      interactions: [{ type: 'Asynchronous/Messages', description: 'event' }],
    }),
    /only Synchronous\/HTTP/,
  );
  assert.throws(() => convertPact({ ...v3Pact, interactions: [] }), /no interactions/);
});

test('converts v4 Synchronous/HTTP interactions with wrapped bodies and array headers', () => {
  const v4Pact = {
    consumer: { name: 'checkout-web' },
    provider: { name: 'orders-service' },
    metadata: { pactSpecification: { version: '4.0' } },
    interactions: [{
      type: 'Synchronous/HTTP',
      description: 'get an order (v4)',
      providerStates: [{ name: 'order 7 exists', params: { id: 7 } }],
      request: {
        method: 'GET',
        path: '/api/orders/7',
        headers: { Accept: ['application/json'] },
      },
      response: {
        status: 200,
        headers: { 'Content-Type': ['application/json'] },
        body: { content: { id: 7, status: 'CREATED' }, contentType: 'application/json' },
        matchingRules: { body: { '$.id': { matchers: [{ match: 'integer' }] } } },
      },
    }],
  };
  const { collection, warnings } = convertPact(v4Pact);
  const item = collection.item[0];
  assert.equal(item.request.header[0].value, 'application/json'); // array header unwrapped
  const script = item.event[0].script.exec.join('\n');
  assert.match(script, /Number\.isInteger\(_\.get\(body, "id"\)\)/); // wrapped body unwrapped
  assert.match(script, /body \$\.status equals expected/);
  assert.equal(warnings.length, 1); // provider state warned without state-change URL
});

test('extended matchers generate the right assertion shapes', () => {
  const script = buildTestScript({
    status: 200,
    body: {
      count: 3, price: 1.5, active: true, gone: null,
      note: 'contains-me', created: '2026-07-28T00:00:00Z', odd: 'x',
    },
    matchingRules: {
      body: {
        '$.count': { matchers: [{ match: 'integer' }] },
        '$.price': { matchers: [{ match: 'decimal' }] },
        '$.active': { matchers: [{ match: 'boolean' }] },
        '$.gone': { matchers: [{ match: 'null' }] },
        '$.note': { matchers: [{ match: 'include', value: 'contains' }] },
        '$.created': { matchers: [{ match: 'datetime' }] },
        '$.odd': { matchers: [{ match: 'somethingUnknown' }] },
      },
    },
  }).join('\n');
  assert.match(script, /Number\.isInteger\(_\.get\(body, "count"\)\)/);
  assert.match(script, /typeof _\.get\(body, "price"\)\)\.to\.eql\("number"\)/);
  assert.match(script, /typeof _\.get\(body, "active"\)\)\.to\.eql\("boolean"\)/);
  assert.match(script, /_\.get\(body, "gone"\)\)\.to\.eql\(null\)/);
  assert.match(script, /String\(_\.get\(body, "note"\)\)\.includes\("contains"\)/);
  assert.match(script, /non-empty datetime string/);
  assert.match(script, /body \$\.odd equals expected/); // unknown matcher -> equality
});

test('array max bound is enforced alongside min', () => {
  const script = buildTestScript({
    status: 200,
    body: { items: [1, 2] },
    matchingRules: { body: { '$.items': { matchers: [{ match: 'type', min: 1, max: 5 }] } } },
  }).join('\n');
  assert.match(script, /to\.be\.at\.least\(1\)/);
  assert.match(script, /to\.be\.at\.most\(5\)/);
});

test('state-change URL emits setup requests before the interaction, in order', () => {
  const { collection, warnings } = convertPact(v3Pact, { stateChangeUrl: 'http://localhost:9999/pact-states' });
  assert.equal(warnings.length, 0); // automated, so no manual-seed warning
  assert.deepEqual(
    collection.item.map((i) => i.name),
    ['[setup] order 42 exists', 'get an order by id', 'create an order'],
  );
  const setup = collection.item[0];
  assert.equal(setup.request.method, 'POST');
  assert.equal(setup.request.url, 'http://localhost:9999/pact-states');
  assert.deepEqual(JSON.parse(setup.request.body.raw), { action: 'setup', state: 'order 42 exists', params: {} });
  assert.match(setup.event[0].script.exec.join('\n'), /to\.be\.below\(300\)/);
});
