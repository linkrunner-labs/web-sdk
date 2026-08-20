'use strict';

// Which host the SDK posts to, and what happens when that host is not serving
// the collector.
//
// The stakes are asymmetric. Posting to the default costs the events of every
// visitor running a blocker, which is the problem first-party collection exists
// to solve. Posting to a first-party host that is not routed yet costs EVERY
// event — a strictly worse failure. Hence the fallback, and hence these tests.

var test = require('node:test');
var assert = require('node:assert');

var loadSdk = require('./helpers/sdk-harness').loadSdk;

var DEFAULT = 'https://api.linkrunner.io/web/ingest';
var FIRST_PARTY = 'https://lr.example.com/web/ingest';

var TOKEN = 'lr_web_test_token';
var PAGE = 'https://example.com/pricing?utm_source=meta&utm_medium=cpc&utm_campaign=aug';

// The retry is scheduled from a promise handler, so it lands a microtask after
// the page view is flushed. setImmediate is a macrotask: everything queued
// before it has run by the time it fires.
function settle() {
  return new Promise(function (resolve) { setImmediate(resolve); });
}

function load(options) {
  options = options || {};
  return loadSdk({
    url: PAGE,
    config: options.config || { token: TOKEN, spa: false, debug: false },
    scriptAttrs: options.scriptAttrs,
    respond: options.respond,
  });
}

test('with nothing configured, events go to the default endpoint', function () {
  var sdk = load();
  sdk.pageView();

  assert.deepStrictEqual(sdk.endpoints(), [DEFAULT]);
});

test('data-endpoint redirects collection to the customer host', function () {
  var sdk = load({ scriptAttrs: { 'data-token': TOKEN, 'data-endpoint': FIRST_PARTY } });
  sdk.pageView();

  assert.deepStrictEqual(sdk.endpoints(), [FIRST_PARTY]);
});

test('window config outranks the script attribute', function () {
  var sdk = load({
    config: { token: TOKEN, endpoint: 'https://own.example.com/web/ingest', spa: false, debug: false },
    scriptAttrs: { 'data-token': TOKEN, 'data-endpoint': FIRST_PARTY },
  });
  sdk.pageView();

  assert.deepStrictEqual(sdk.endpoints(), ['https://own.example.com/web/ingest']);
});

// Nothing about the destination may leak into the event itself, or the same
// visit would be recorded differently depending on how the site is integrated.
test('the payload is unchanged by which host it goes to', function () {
  var firstParty = load({ scriptAttrs: { 'data-token': TOKEN, 'data-endpoint': FIRST_PARTY } }).pageView();
  var direct = load().pageView();

  assert.strictEqual(firstParty.event_type, direct.event_type);
  assert.deepStrictEqual(Object.keys(firstParty).sort(), Object.keys(direct).sort());
});

// The case that makes data-endpoint safe to set before the route behind it is
// live: an unrouted host hands /web/ingest to the branded-link handler, which is
// GET-only and answers 405 to both the preflight and the POST.
test('a first-party host that 405s is retried on the default', async function () {
  var sdk = load({
    scriptAttrs: { 'data-token': TOKEN, 'data-endpoint': FIRST_PARTY },
    respond: function (endpoint) {
      return endpoint === FIRST_PARTY ? { ok: false, status: 405 } : { ok: true, status: 200 };
    },
  });

  sdk.pageView();
  await settle();

  assert.deepStrictEqual(sdk.endpoints(), [FIRST_PARTY, DEFAULT]);
  // The event is not merely re-attempted, it arrives — and arrives intact.
  assert.strictEqual(sdk.sent.length, 1);
  assert.strictEqual(sdk.sent[0].event_type, 'page_view');
  assert.deepStrictEqual(sdk.attempts[0].body, sdk.attempts[1].body);
});

test('a refused preflight or blocked request is retried on the default', async function () {
  var sdk = load({
    scriptAttrs: { 'data-token': TOKEN, 'data-endpoint': FIRST_PARTY },
    respond: function (endpoint) {
      return endpoint === FIRST_PARTY ? 'network-error' : { ok: true, status: 200 };
    },
  });

  sdk.pageView();
  await settle();

  assert.deepStrictEqual(sdk.endpoints(), [FIRST_PARTY, DEFAULT]);
  assert.strictEqual(sdk.sent.length, 1);
});

test('a 404 on the first-party host is retried on the default', async function () {
  var sdk = load({
    scriptAttrs: { 'data-token': TOKEN, 'data-endpoint': FIRST_PARTY },
    respond: function (endpoint) {
      return endpoint === FIRST_PARTY ? { ok: false, status: 404 } : { ok: true, status: 200 };
    },
  });

  sdk.pageView();
  await settle();

  assert.deepStrictEqual(sdk.endpoints(), [FIRST_PARTY, DEFAULT]);
});

// 400 is our own backend reading the payload and rejecting it. Both hosts reach
// the same backend, so the retry would be rejected identically — and if it were
// NOT rejected, the event would be counted twice.
test('a 400 is not retried', async function () {
  var sdk = load({
    scriptAttrs: { 'data-token': TOKEN, 'data-endpoint': FIRST_PARTY },
    respond: function () { return { ok: false, status: 400 }; },
  });

  sdk.pageView();
  await settle();

  assert.deepStrictEqual(sdk.endpoints(), [FIRST_PARTY]);
});

// 5xx means the backend may already have enqueued the event. Retrying on another
// host that reaches the same backend would double-count it.
test('a 502 is not retried', async function () {
  var sdk = load({
    scriptAttrs: { 'data-token': TOKEN, 'data-endpoint': FIRST_PARTY },
    respond: function () { return { ok: false, status: 502 }; },
  });

  sdk.pageView();
  await settle();

  assert.deepStrictEqual(sdk.endpoints(), [FIRST_PARTY]);
});

// The retry target cannot itself retry, or a hard outage becomes an infinite
// resend loop from every page on the internet running the bundle.
test('a failure on the default endpoint is not retried', async function () {
  var sdk = load({ respond: function () { return 'network-error'; } });

  sdk.pageView();
  await settle();
  await settle();

  assert.deepStrictEqual(sdk.endpoints(), [DEFAULT]);
});

// Same guard, reached the other way: a site that explicitly points data-endpoint
// at the default gets one attempt, not two.
test('an explicit endpoint equal to the default is not retried', async function () {
  var sdk = load({
    scriptAttrs: { 'data-token': TOKEN, 'data-endpoint': DEFAULT },
    respond: function () { return 'network-error'; },
  });

  sdk.pageView();
  await settle();
  await settle();

  assert.deepStrictEqual(sdk.endpoints(), [DEFAULT]);
});
