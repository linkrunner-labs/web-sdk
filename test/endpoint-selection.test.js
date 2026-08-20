'use strict';

// Which host the SDK posts to, and what happens when that host is not serving
// the collector.
//
// The stakes are asymmetric. Sending to the default costs the events of every
// visitor running a blocker, which is the problem this feature exists to solve.
// Sending to a first-party host that is not routed yet costs EVERY event —
// a strictly worse failure, and one shipped by us rather than chosen by the
// customer. Hence the fallback, and hence these tests.

var test = require('node:test');
var assert = require('node:assert');

var loadSdk = require('./helpers/sdk-harness').loadSdk;

var DEFAULT = 'https://api.linkrunner.io/web/ingest';
var PLAYO_TOKEN = 'lr_web_fyy3R021a1IgsYS7p1CIwJta';
var PLAYO_ENDPOINT = 'https://app.playo.co/web/ingest';

var PAGE = 'https://playo.co/venues?utm_source=meta&utm_medium=cpc&utm_campaign=aug';

// The retry is scheduled from a promise handler, so it lands a microtask after
// the page view is flushed. setImmediate is a macrotask: everything queued
// before it has run by the time it fires.
function settle() {
  return new Promise(function (resolve) { setImmediate(resolve); });
}

function load(options) {
  return loadSdk({
    url: PAGE,
    config: options.config,
    scriptAttrs: options.scriptAttrs,
    respond: options.respond,
  });
}

test('an unmapped token posts to the default endpoint', function () {
  var sdk = load({ config: { token: 'lr_web_someone_else', spa: false, debug: false } });
  sdk.pageView();

  assert.deepStrictEqual(sdk.endpoints(), [DEFAULT]);
});

test('a mapped token posts to its first-party host', function () {
  var sdk = load({ config: { token: PLAYO_TOKEN, spa: false, debug: false } });
  sdk.pageView();

  assert.deepStrictEqual(sdk.endpoints(), [PLAYO_ENDPOINT]);
});

test('the payload is unchanged by which host it goes to', function () {
  var mapped = load({ config: { token: PLAYO_TOKEN, spa: false, debug: false } }).pageView();
  var direct = load({ config: { token: 'lr_web_someone_else', spa: false, debug: false } }).pageView();

  assert.strictEqual(mapped.event_type, direct.event_type);
  assert.deepStrictEqual(Object.keys(mapped).sort(), Object.keys(direct).sort());
});

// A customer in the table must be able to move or revert themselves from their
// own page, without waiting on a bundle release from us.
test('data-endpoint outranks the table', function () {
  var sdk = load({
    config: { token: PLAYO_TOKEN, spa: false, debug: false },
    scriptAttrs: { 'data-token': PLAYO_TOKEN, 'data-endpoint': 'https://metrics.playo.co/web/ingest' },
  });
  sdk.pageView();

  assert.deepStrictEqual(sdk.endpoints(), ['https://metrics.playo.co/web/ingest']);
});

test('window config outranks both', function () {
  var sdk = load({
    config: { token: PLAYO_TOKEN, endpoint: 'https://own.playo.co/web/ingest', spa: false, debug: false },
    scriptAttrs: { 'data-token': PLAYO_TOKEN, 'data-endpoint': 'https://metrics.playo.co/web/ingest' },
  });
  sdk.pageView();

  assert.deepStrictEqual(sdk.endpoints(), ['https://own.playo.co/web/ingest']);
});

// The table is an object literal, so a token that names an Object.prototype
// member would resolve to a function and be handed to fetch as a URL.
test('a token colliding with a prototype member falls through to the default', function () {
  ['constructor', 'toString', 'hasOwnProperty', '__proto__'].forEach(function (token) {
    var sdk = load({ config: { token: token, spa: false, debug: false } });
    sdk.pageView();

    assert.deepStrictEqual(sdk.endpoints(), [DEFAULT], token + ' should not select a mapped endpoint');
  });
});

// This is the case that makes the table safe to ship before ops routes the
// host: app.playo.co/web/ingest answers 405 from the branded-link handler,
// which is GET-only, and the CORS preflight fails the same way.
test('a first-party host that 405s is retried on the default', async function () {
  var sdk = load({
    config: { token: PLAYO_TOKEN, spa: false, debug: false },
    respond: function (endpoint) {
      return endpoint === PLAYO_ENDPOINT ? { ok: false, status: 405 } : { ok: true, status: 200 };
    },
  });

  sdk.pageView();
  await settle();

  assert.deepStrictEqual(sdk.endpoints(), [PLAYO_ENDPOINT, DEFAULT]);
  // The event is not merely re-attempted, it arrives — and arrives intact.
  assert.strictEqual(sdk.sent.length, 1);
  assert.strictEqual(sdk.sent[0].event_type, 'page_view');
  assert.deepStrictEqual(sdk.attempts[0].body, sdk.attempts[1].body);
});

test('a refused preflight or blocked request is retried on the default', async function () {
  var sdk = load({
    config: { token: PLAYO_TOKEN, spa: false, debug: false },
    respond: function (endpoint) {
      return endpoint === PLAYO_ENDPOINT ? 'network-error' : { ok: true, status: 200 };
    },
  });

  sdk.pageView();
  await settle();

  assert.deepStrictEqual(sdk.endpoints(), [PLAYO_ENDPOINT, DEFAULT]);
  assert.strictEqual(sdk.sent.length, 1);
});

test('a 404 on the first-party host is retried on the default', async function () {
  var sdk = load({
    config: { token: PLAYO_TOKEN, spa: false, debug: false },
    respond: function (endpoint) {
      return endpoint === PLAYO_ENDPOINT ? { ok: false, status: 404 } : { ok: true, status: 200 };
    },
  });

  sdk.pageView();
  await settle();

  assert.deepStrictEqual(sdk.endpoints(), [PLAYO_ENDPOINT, DEFAULT]);
});

// 400 is our own backend reading the payload and rejecting it. Both hosts reach
// the same backend, so the retry would be rejected identically — and if it were
// NOT rejected, the event would be counted twice.
test('a 400 is not retried', async function () {
  var sdk = load({
    config: { token: PLAYO_TOKEN, spa: false, debug: false },
    respond: function () { return { ok: false, status: 400 }; },
  });

  sdk.pageView();
  await settle();

  assert.deepStrictEqual(sdk.endpoints(), [PLAYO_ENDPOINT]);
});

// 5xx means the backend may already have enqueued the event. Retrying on
// another host that reaches the same backend would double-count it.
test('a 502 is not retried', async function () {
  var sdk = load({
    config: { token: PLAYO_TOKEN, spa: false, debug: false },
    respond: function () { return { ok: false, status: 502 }; },
  });

  sdk.pageView();
  await settle();

  assert.deepStrictEqual(sdk.endpoints(), [PLAYO_ENDPOINT]);
});

// The retry target cannot itself retry, or a hard outage becomes an infinite
// resend loop from every page on the internet running the bundle.
test('a failure on the default endpoint is not retried', async function () {
  var sdk = load({
    config: { token: 'lr_web_someone_else', spa: false, debug: false },
    respond: function () { return 'network-error'; },
  });

  sdk.pageView();
  await settle();
  await settle();

  assert.deepStrictEqual(sdk.endpoints(), [DEFAULT]);
});

// Same guard, reached the other way: a customer who explicitly points
// data-endpoint at the default gets one attempt, not two.
test('an explicit endpoint equal to the default is not retried', async function () {
  var sdk = load({
    config: { token: PLAYO_TOKEN, endpoint: DEFAULT, spa: false, debug: false },
    respond: function () { return 'network-error'; },
  });

  sdk.pageView();
  await settle();
  await settle();

  assert.deepStrictEqual(sdk.endpoints(), [DEFAULT]);
});
