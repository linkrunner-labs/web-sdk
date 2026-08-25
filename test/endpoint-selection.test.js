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

// data-domain: how every new integration gets a first-party beacon. The
// customer names the subdomain they CNAME'd to us and the SDK builds the URL,
// so the collector's path stays ours to change.
test('data-domain posts to the customer host on our path', function () {
  var sdk = load({
    config: { token: 'lr_web_someone_else', spa: false, debug: false },
    scriptAttrs: { 'data-token': 'lr_web_someone_else', 'data-domain': 'lr.example.com' },
  });
  sdk.pageView();

  assert.deepStrictEqual(sdk.endpoints(), ['https://lr.example.com/web/ingest']);
});

// Whatever the customer pastes into the attribute has to land on the same URL.
// Getting this wrong is invisible on their side and silent on ours.
test('data-domain accepts anything a customer plausibly pastes', function () {
  [
    'lr.example.com',
    ' lr.example.com ',
    'https://lr.example.com',
    'http://lr.example.com',
    '//lr.example.com',
    'lr.example.com/',
    'https://lr.example.com/web/ingest',
    'https://lr.example.com/some/path?x=1#y',
  ].forEach(function (value) {
    var sdk = load({
      config: { token: 'lr_web_someone_else', spa: false, debug: false },
      scriptAttrs: { 'data-token': 'lr_web_someone_else', 'data-domain': value },
    });
    sdk.pageView();

    assert.deepStrictEqual(
      sdk.endpoints(), ['https://lr.example.com/web/ingest'], 'for ' + JSON.stringify(value));
  });
});

// A value that is not a hostname must not become a URL. Falling back to the
// default costs blocker traffic; sending to a mis-parsed host costs everything.
test('an unusable data-domain falls back rather than guessing', function () {
  ['', '   ', 'not a host', 'https://', 'lr.example.com:not-a-port', 'javascript:alert(1)']
    .forEach(function (value) {
      var sdk = load({
        config: { token: 'lr_web_someone_else', spa: false, debug: false },
        scriptAttrs: { 'data-token': 'lr_web_someone_else', 'data-domain': value },
      });
      sdk.pageView();

      assert.deepStrictEqual(sdk.endpoints(), [DEFAULT], 'for ' + JSON.stringify(value));
    });
});

// Credentials in the authority are refused rather than stripped. Stripping
// resolves this to evil.test while the attribute still reads like the
// customer's own subdomain, which is the one way a wrong host can look right.
test('data-domain refuses userinfo in the authority', function () {
  ['https://lr.example.com@evil.test', 'user:pass@lr.example.com', '@evil.test'].forEach(function (value) {
    var sdk = load({
      config: { token: 'lr_web_someone_else', spa: false, debug: false },
      scriptAttrs: { 'data-token': 'lr_web_someone_else', 'data-domain': value },
    });
    sdk.pageView();

    assert.deepStrictEqual(sdk.endpoints(), [DEFAULT], 'for ' + JSON.stringify(value));
  });
});

// The two rejection paths are not the same problem, and the console is the only
// place a customer finds out which one they hit.
test('a refused data-domain says why it was refused', function () {
  var messages = [];
  var realError = console.error;
  console.error = function () { messages.push(Array.prototype.join.call(arguments, ' ')); };

  try {
    load({
      config: { token: 'lr_web_someone_else', spa: false, debug: true },
      scriptAttrs: { 'data-token': 'lr_web_someone_else', 'data-domain': 'user:pass@lr.example.com' },
    });
    load({
      config: { token: 'lr_web_someone_else', spa: false, debug: true },
      scriptAttrs: { 'data-token': 'lr_web_someone_else', 'data-domain': 'not a host' },
    });
  } finally {
    console.error = realError;
  }

  var credentials = messages.filter(function (m) { return m.indexOf('credentials') !== -1; });
  var notAHost = messages.filter(function (m) { return m.indexOf('not a hostname') !== -1; });

  assert.strictEqual(credentials.length, 1, 'the credentials case names credentials');
  assert.strictEqual(notAHost.length, 1, 'the malformed case still says not a hostname');
  // Both must name the value and where events are going instead, or the
  // customer cannot tell which attribute is at fault. Matched in position
  // rather than by substring: the message has to END by naming the endpoint,
  // which is the part that makes it actionable.
  assert.match(credentials[0], /"user:pass@lr\.example\.com": it carries credentials/);
  assert.match(credentials[0], /sending to https:\/\/api\.linkrunner\.io\/web\/ingest instead\.$/);
});

// An IDN host is legal and reaches the wire as punycode. Rejecting it would
// leave that customer on the default host looking correctly configured.
test('data-domain converts an internationalized host to punycode', function () {
  var sdk = load({
    config: { token: 'lr_web_someone_else', spa: false, debug: false },
    scriptAttrs: { 'data-token': 'lr_web_someone_else', 'data-domain': 'lr.münchen.de' },
  });
  sdk.pageView();

  assert.deepStrictEqual(sdk.endpoints(), ['https://lr.xn--mnchen-3ya.de/web/ingest']);
});

test('window config domain works the same as the attribute', function () {
  var sdk = load({ config: { token: 'lr_web_someone_else', domain: 'lr.example.com', spa: false, debug: false } });
  sdk.pageView();

  assert.deepStrictEqual(sdk.endpoints(), ['https://lr.example.com/web/ingest']);
});

// A rejected value drops out of the chain, it does not skip to the end. For a
// token in the table that means the mapped host, which is both first-party and
// verified — strictly better than the default. Pinned so a future reordering of
// the precedence chain cannot quietly downgrade it.
test('an invalid data-domain falls to the table, not past it', function () {
  var sdk = load({
    config: { token: PLAYO_TOKEN, spa: false, debug: false },
    scriptAttrs: { 'data-token': PLAYO_TOKEN, 'data-domain': 'not a host' },
  });
  sdk.pageView();

  assert.deepStrictEqual(sdk.endpoints(), [PLAYO_ENDPOINT]);
  assert.strictEqual(sdk.sent.length, 1);
});

// Playo is in the table AND could set the attribute. The attribute is theirs
// and the table is ours, so theirs wins — that is what lets them leave it.
test('data-domain outranks the table', function () {
  var sdk = load({
    config: { token: PLAYO_TOKEN, spa: false, debug: false },
    scriptAttrs: { 'data-token': PLAYO_TOKEN, 'data-domain': 'metrics.playo.co' },
  });
  sdk.pageView();

  assert.deepStrictEqual(sdk.endpoints(), ['https://metrics.playo.co/web/ingest']);
});

// data-endpoint carries a path; data-domain cannot. A site proxying collection
// on its own origin has only the endpoint form, so it must stay on top.
test('data-endpoint outranks data-domain', function () {
  var sdk = load({
    config: { token: 'lr_web_someone_else', spa: false, debug: false },
    scriptAttrs: {
      'data-token': 'lr_web_someone_else',
      'data-domain': 'lr.example.com',
      'data-endpoint': '/lr/ingest',
    },
  });
  sdk.pageView();

  assert.deepStrictEqual(sdk.endpoints(), ['/lr/ingest']);
});

// The customer's own edge is in the path now, and it speaks statuses our
// collector never does. Each of these means nothing was enqueued, so the retry
// cannot double-count — and without it, every event is lost.
test('an edge that refuses or has nothing behind it is retried on the default', async function () {
  for (var i = 0; i < 4; i++) {
    var status = [403, 404, 502, 503][i];
    var sdk = load({
      config: { token: 'lr_web_someone_else', spa: false, debug: false },
      scriptAttrs: { 'data-token': 'lr_web_someone_else', 'data-domain': 'lr.example.com' },
      respond: (function (s) {
        return function (endpoint) {
          return endpoint === 'https://lr.example.com/web/ingest'
            ? { ok: false, status: s }
            : { ok: true, status: 200 };
        };
      })(status),
    });

    sdk.pageView();
    await settle();

    assert.deepStrictEqual(
      sdk.endpoints(), ['https://lr.example.com/web/ingest', DEFAULT], 'status ' + status);
    assert.strictEqual(sdk.sent.length, 1, 'status ' + status);
  }
});

// The other half of the rule: a status the collector DOES emit means it read
// the request, so the retry would be rejected identically or double-count.
test('a status our collector itself returns is not retried', async function () {
  for (var i = 0; i < 4; i++) {
    var status = [400, 401, 413, 504][i];
    var sdk = load({
      config: { token: 'lr_web_someone_else', spa: false, debug: false },
      scriptAttrs: { 'data-token': 'lr_web_someone_else', 'data-domain': 'lr.example.com' },
      respond: (function (s) {
        return function () { return { ok: false, status: s }; };
      })(status),
    });

    sdk.pageView();
    await settle();

    assert.deepStrictEqual(sdk.endpoints(), ['https://lr.example.com/web/ingest'], 'status ' + status);
  }
});

// A domain host is first-party, so it gets the same safety net as the table:
// if the collector is not routed there yet, the event still arrives.
test('a data-domain host that 405s is retried on the default', async function () {
  var sdk = load({
    config: { token: 'lr_web_someone_else', spa: false, debug: false },
    scriptAttrs: { 'data-token': 'lr_web_someone_else', 'data-domain': 'lr.example.com' },
    respond: function (endpoint) {
      return endpoint === 'https://lr.example.com/web/ingest'
        ? { ok: false, status: 405 }
        : { ok: true, status: 200 };
    },
  });

  sdk.pageView();
  await settle();

  assert.deepStrictEqual(sdk.endpoints(), ['https://lr.example.com/web/ingest', DEFAULT]);
  assert.strictEqual(sdk.sent.length, 1);
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

// A 500 is our own handler's catch block, and a 504 is a timeout that can mean
// the request was processed and only the response was lost. Either way the
// event may already be enqueued, and retrying on a host that reaches the same
// backend would double-count it.
//
// 502 and 503 are NOT in this group and are retried: a gateway with nothing
// behind it never reached an application at all. See shouldFallBack.
test('a 500 or 504 is not retried', async function () {
  for (var i = 0; i < 2; i++) {
    var status = [500, 504][i];
    var sdk = load({
      config: { token: PLAYO_TOKEN, spa: false, debug: false },
      respond: (function (s) {
        return function () { return { ok: false, status: s }; };
      })(status),
    });

    sdk.pageView();
    await settle();

    assert.deepStrictEqual(sdk.endpoints(), [PLAYO_ENDPOINT], 'status ' + status);
  }
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
