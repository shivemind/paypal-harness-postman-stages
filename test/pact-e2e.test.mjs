// End-to-end proof of the consumer-contract flow: pact -> generated
// collection -> real HTTP replay against a live in-test provider -> the
// generated pm.test assertions executed in a faithful sandbox shim.
// Healthy responses (with extra provider fields) must pass; each sabotage
// must fail the exact generated assertion that guards it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { convertPact, resolvePath } from '../scripts/pact-to-collection.mjs';

// --- Minimal Postman-sandbox shim: just the API surface the generator emits.
function expectApi(actual) {
  return {
    to: {
      eql(expected) { assert.deepStrictEqual(actual, expected); },
      match(re) { assert.match(String(actual), re); },
      be: {
        below(n) { assert.ok(actual < n, `${actual} is not below ${n}`); },
        at: {
          least(n) { assert.ok(actual >= n, `${actual} is below ${n}`); },
          most(n) { assert.ok(actual <= n, `${actual} is above ${n}`); },
        },
      },
    },
  };
}

function runScript(exec, response) {
  const failures = [];
  const executed = [];
  const headerGet = (name) => response.headers[name.toLowerCase()] ?? null;
  const pm = {
    expect: expectApi,
    test(name, fn) {
      executed.push(name);
      try { fn(); } catch (error) { failures.push({ name, message: error.message }); }
    },
    response: {
      code: response.status,
      json() { return JSON.parse(response.bodyText); },
      headers: { get: headerGet },
      to: {
        have: {
          status(code) { assert.equal(response.status, code); },
          header(name) { assert.ok(headerGet(name) !== null, `missing header ${name}`); },
        },
      },
    },
  };
  const requireShim = (id) => {
    assert.equal(id, 'lodash');
    return { get: (obj, path) => resolvePath(obj, path) };
  };
  new Function('pm', 'require', exec.join('\n'))(pm, requireShim);
  return { failures, executed };
}

// --- Execute a generated collection item as a real HTTP request.
async function executeItem(item, baseUrl) {
  let url;
  if (typeof item.request.url === 'string') {
    url = item.request.url;
  } else {
    url = item.request.url.raw.replace('{{baseUrl}}', baseUrl);
    const query = item.request.url.query ?? [];
    if (query.length > 0) {
      url += `?${query.map((q) => `${encodeURIComponent(q.key)}=${encodeURIComponent(q.value)}`).join('&')}`;
    }
  }
  const headers = Object.fromEntries((item.request.header ?? []).map((h) => [h.key, h.value]));
  const init = { method: item.request.method, headers };
  if (item.request.body?.raw) init.body = item.request.body.raw;
  const res = await fetch(url, init);
  const bodyText = await res.text();
  const responseHeaders = {};
  res.headers.forEach((value, key) => { responseHeaders[key.toLowerCase()] = value; });
  return { status: res.status, headers: responseHeaders, bodyText };
}

async function replayCollection(collection, baseUrl) {
  const results = [];
  for (const item of collection.item) {
    const response = await executeItem(item, baseUrl);
    const { failures } = runScript(item.event[0].script.exec, response);
    results.push({ name: item.name, failures });
  }
  return results;
}

const failureNames = (results) => results.flatMap((r) => r.failures.map((f) => f.name));

// --- Live in-test provider with swappable behavior for sabotage scenarios.
const requestLog = [];
let orderHandler = () => [200, {}];

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const path = req.url.split('?')[0];
    requestLog.push({ method: req.method, path, body: raw ? JSON.parse(raw) : null });
    const respond = (status, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'POST' && path === '/pact-states') return respond(200, { ok: true });
    if (req.method === 'GET' && path === '/api/orders/42') {
      const [status, body, headers] = orderHandler();
      return respond(status, body, headers);
    }
    if (req.method === 'POST' && path === '/api/orders') return respond(201, { status: 'CREATED', id: '9' });
    return respond(404, { error: 'not found' });
  });
});

server.listen(0, '127.0.0.1');
await once(server, 'listening');
const baseUrl = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const healthyOrder = () => [200, {
  id: '42',
  status: 'CREATED',
  links: [{ rel: 'self', href: 'https://api.test/orders/42' }],
  // Extra provider fields the consumer never declared — must be tolerated.
  create_time: '2026-07-28T00:00:00Z',
  payer: { email: 'x@example.com' },
}];

const consumerPact = {
  consumer: { name: 'checkout-web' },
  provider: { name: 'orders-service' },
  metadata: { pactSpecification: { version: '3.0.0' } },
  interactions: [
    {
      description: 'get an order by id',
      providerStates: [{ name: 'order 42 exists', params: { id: 42 } }],
      request: { method: 'GET', path: '/api/orders/42', headers: { Accept: 'application/json' } },
      response: {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: { id: '42', status: 'CREATED', links: [{ rel: 'self', href: 'https://api.test/orders/42' }] },
        matchingRules: {
          body: {
            '$.id': { matchers: [{ match: 'type' }] },
            '$.links': { matchers: [{ match: 'type', min: 1 }] },
            '$.links[*].href': { matchers: [{ match: 'regex', regex: '^https://' }] },
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
      response: {
        status: 201,
        body: { status: 'CREATED' },
        matchingRules: { body: { '$.status': { matchers: [{ match: 'type' }] } } },
      },
    },
  ],
};

test('healthy provider passes every generated assertion, extra fields tolerated', async () => {
  orderHandler = healthyOrder;
  const { collection } = convertPact(consumerPact);
  const results = await replayCollection(collection, baseUrl);
  assert.deepEqual(failureNames(results), []);
});

test('request bodies are forwarded to the provider as committed', async () => {
  orderHandler = healthyOrder;
  requestLog.length = 0;
  const { collection } = convertPact(consumerPact);
  await replayCollection(collection, baseUrl);
  const post = requestLog.find((r) => r.method === 'POST' && r.path === '/api/orders');
  assert.deepEqual(post.body, { intent: 'CAPTURE' });
});

test('state-change setup POSTs to the provider before the interaction replays', async () => {
  orderHandler = healthyOrder;
  requestLog.length = 0;
  const { collection, warnings } = convertPact(consumerPact, { stateChangeUrl: `${baseUrl}/pact-states` });
  assert.deepEqual(warnings, []);
  const results = await replayCollection(collection, baseUrl);
  assert.deepEqual(failureNames(results), []);
  const setupIndex = requestLog.findIndex((r) => r.path === '/pact-states');
  const getIndex = requestLog.findIndex((r) => r.method === 'GET' && r.path === '/api/orders/42');
  assert.ok(setupIndex >= 0 && setupIndex < getIndex, 'setup must precede the interaction');
  assert.deepEqual(requestLog[setupIndex].body, { action: 'setup', state: 'order 42 exists', params: { id: 42 } });
});

test('sabotage: wrong leaf type fails exactly the type assertion', async () => {
  orderHandler = () => [200, { id: 42, status: 'CREATED', links: [{ rel: 'self', href: 'https://x' }] }];
  const { collection } = convertPact(consumerPact);
  const results = await replayCollection(collection, baseUrl);
  assert.deepEqual(failureNames(results), ['body $.id matches type string']);
});

test('sabotage: missing consumer-relied field fails its equality assertion', async () => {
  orderHandler = () => [200, { id: '42', links: [{ rel: 'self', href: 'https://x' }] }];
  const { collection } = convertPact(consumerPact);
  const results = await replayCollection(collection, baseUrl);
  assert.deepEqual(failureNames(results), ['body $.status equals expected']);
});

test('sabotage: regex-guarded link degrading to http fails the regex assertion', async () => {
  orderHandler = () => [200, { id: '42', status: 'CREATED', links: [{ rel: 'self', href: 'http://insecure' }] }];
  const { collection } = convertPact(consumerPact);
  const results = await replayCollection(collection, baseUrl);
  assert.deepEqual(failureNames(results), ['body $.links[0].href matches ^https://']);
});

test('sabotage: emptied links array fails the min bound and the element assertions', async () => {
  orderHandler = () => [200, { id: '42', status: 'CREATED', links: [] }];
  const { collection } = convertPact(consumerPact);
  const results = await replayCollection(collection, baseUrl);
  assert.deepEqual(failureNames(results), [
    'body $.links is an array', // min-1 bound violated
    'body $.links[0].rel matches type string', // relied-on element fields gone too
    'body $.links[0].href matches ^https://',
  ]);
});

test('sabotage: wrong status and content type fail status and header assertions', async () => {
  orderHandler = () => [500, { id: '42', status: 'CREATED', links: [{ rel: 'self', href: 'https://x' }] }, { 'Content-Type': 'text/plain' }];
  const { collection } = convertPact(consumerPact);
  const results = await replayCollection(collection, baseUrl);
  assert.deepEqual(failureNames(results), ['status is 200', 'header Content-Type equals expected']);
});

test('v4 Synchronous/HTTP contract replays end to end', async () => {
  orderHandler = () => [200, { id: 42, status: 'CREATED' }];
  const v4Pact = {
    consumer: { name: 'mobile-app' },
    provider: { name: 'orders-service' },
    metadata: { pactSpecification: { version: '4.0' } },
    interactions: [{
      type: 'Synchronous/HTTP',
      description: 'get an order (v4)',
      request: { method: 'GET', path: '/api/orders/42', headers: { Accept: ['application/json'] } },
      response: {
        status: 200,
        body: { content: { id: 42 }, contentType: 'application/json' },
        matchingRules: { body: { '$.id': { matchers: [{ match: 'integer' }] } } },
      },
    }],
  };
  const { collection } = convertPact(v4Pact);
  const results = await replayCollection(collection, baseUrl);
  assert.deepEqual(failureNames(results), []);

  orderHandler = () => [200, { id: 'not-a-number', status: 'CREATED' }];
  const sabotaged = await replayCollection(collection, baseUrl);
  assert.deepEqual(failureNames(sabotaged), ['body $.id is an integer']);
});
