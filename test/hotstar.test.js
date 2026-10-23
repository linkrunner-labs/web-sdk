'use strict';

// LIN-4025: JioHotstar web campaigns. A landing with hsClkId must be stored and read as
// a Hotstar click, and with a pixel id configured lr.track() must reach Hotstar's own
// pixel (hspixel) for the events Hotstar supports, and nothing else.

var test = require('node:test');
var assert = require('node:assert');

var harness = require('./helpers/sdk-harness');
var loadSdk = harness.loadSdk;
var createClock = harness.createClock;
var createStorage = harness.createStorage;
var MINUTE = harness.MINUTE;

var LANDING = 'https://shop.example/?hsClkId=hs-click-1&utm_source=jiohotstar&utm_medium=cpm';
var PIXEL_CONFIG = { token: 'test_token', spa: false, debug: false, hotstarPixelId: 'px-123' };

function visitor() {
  var clock = createClock();
  var localStorage = createStorage();
  return {
    clock: clock,
    load: function (url, config) {
      return loadSdk({
        url: url,
        clock: clock,
        localStorage: localStorage,
        sessionStorage: createStorage(),
        config: config,
      });
    },
  };
}

// What hspixel() was called with, in order: the queued calls before Hotstar's script
// loads, which is where every call lands in a test (the script never loads here).
function hotstarCalls(sdk) {
  var pixel = sdk.sandbox.hspixel;
  return pixel ? plain(Array.prototype.map.call(pixel.queue, function (args) { return Array.prototype.slice.call(args); })) : [];
}

// Objects built inside the SDK's vm context carry that context's prototypes, which
// deepStrictEqual rejects; a JSON round trip brings them into this realm.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('hsClkId is stored as a click id and read as JioHotstar traffic', function () {
  var landing = visitor().load(LANDING).pageView();

  assert.strictEqual(landing.hsclkid, 'hs-click-1');
  assert.strictEqual(landing.ft_hsclkid, 'hs-click-1');
  assert.strictEqual(landing.traffic_source_type, 'paid_display');
  assert.strictEqual(landing.traffic_source_name, 'jiohotstar');
});

test('hsClkId is accepted in any casing', function () {
  var landing = visitor().load('https://shop.example/?HSCLKID=upper-1').pageView();
  assert.strictEqual(landing.hsclkid, 'upper-1');
});

test('the click id reaches a purchase on a later page and expires after 90 days', function () {
  var v = visitor();
  v.load(LANDING).pageView();

  v.clock.advance(9 * MINUTE);
  var purchase = v.load('https://shop.example/thanks').track('purchase', { amount: 400 });
  assert.strictEqual(purchase.hsclkid, 'hs-click-1');
  assert.strictEqual(purchase.ft_hsclkid, 'hs-click-1');

  v.clock.advance(91 * 24 * 60 * MINUTE);
  var late = v.load('https://shop.example/thanks').track('purchase', { amount: 400 });
  assert.strictEqual(late.hsclkid, '');
  // First touch has no expiry, like every other first-touch click id.
  assert.strictEqual(late.ft_hsclkid, 'hs-click-1');
});

test('first touch keeps the first Hotstar click when a later one replaces last touch', function () {
  var v = visitor();
  v.load('https://shop.example/?hsClkId=first').pageView();
  v.clock.advance(MINUTE);
  var view = v.load('https://shop.example/?hsClkId=second').pageView();

  assert.strictEqual(view.hsclkid, 'second');
  assert.strictEqual(view.ft_hsclkid, 'first');
});

test('a visit without hsClkId sends empty values and no Hotstar request', function () {
  var sdk = visitor().load('https://shop.example/');
  var view = sdk.pageView();

  assert.strictEqual(view.hsclkid, '');
  assert.strictEqual(view.ft_hsclkid, '');
  sdk.track('purchase', { amount: 1 });
  assert.strictEqual(sdk.sandbox.hspixel, undefined);
  assert.strictEqual(sdk.injectedScripts.length, 0);
});

test('with a pixel id it loads Hotstar\'s script, inits and sends one PageView', function () {
  var sdk = visitor().load(LANDING, PIXEL_CONFIG);

  assert.strictEqual(sdk.injectedScripts.length, 1);
  assert.strictEqual(sdk.injectedScripts[0].src, 'https://hspx.hotstar.com/static/pixel/hspixel.js');
  assert.deepStrictEqual(hotstarCalls(sdk), [['init', 'px-123'], ['track', 'PageView']]);
});

test('lr.track purchase is forwarded with Hotstar parameter names, amount becoming value', function () {
  var sdk = visitor().load(LANDING, PIXEL_CONFIG);
  var sent = sdk.track('purchase', { amount: 400, purchase_id: 'OD1', cdf1: 'gold', coupon: 'X', nested: { a: 1 } });

  assert.strictEqual(sent.event_name, 'purchase'); // Linkrunner still gets the original
  assert.deepStrictEqual(hotstarCalls(sdk).pop(), [
    'track',
    'Purchase',
    { purchase_id: 'OD1', value: '400', cdf1: 'gold' },
  ]);
});

test('event names match ignoring case, spaces and underscores', function () {
  var sdk = visitor().load(LANDING, PIXEL_CONFIG);
  ['Add_To_Cart', 'sign up', 'GenerateLead', 'lead', 'view-content', 'Search', 'initiate_checkout'].forEach(function (name) {
    sdk.track(name, {});
  });

  var forwarded = hotstarCalls(sdk).slice(2).map(function (call) { return call[1]; });
  assert.deepStrictEqual(forwarded, [
    'AddToCart', 'SignUp', 'GenerateLead', 'GenerateLead', 'ViewContent', 'Search', 'InitiateCheckout',
  ]);
});

test('events Hotstar has no equivalent for stay with Linkrunner', function () {
  var sdk = visitor().load(LANDING, PIXEL_CONFIG);
  sdk.track('video_played', { value: 1 });
  sdk.track('page_view', {});

  assert.strictEqual(hotstarCalls(sdk).length, 2); // init + PageView only
});

test('an existing hspixel on the page is reused, not initialised again', function () {
  var calls = [];
  var sdk = loadSdk({
    url: LANDING,
    config: PIXEL_CONFIG,
    hspixel: function () { calls.push(Array.prototype.slice.call(arguments)); },
  });

  assert.strictEqual(sdk.injectedScripts.length, 0);
  assert.deepStrictEqual(calls, []);
  sdk.track('signup', { subscription_id: 's1' });
  assert.deepStrictEqual(plain(calls), [['track', 'SignUp', { subscription_id: 's1' }]]);
});

test('events queued before the script loads still reach Hotstar', function () {
  var sdk = loadSdk({
    url: LANDING,
    config: PIXEL_CONFIG,
    preQueue: [['purchase', { amount: 10 }]],
  });

  assert.deepStrictEqual(hotstarCalls(sdk).pop(), ['track', 'Purchase', { value: '10' }]);
});

test('a failing Hotstar pixel never stops the Linkrunner event', function () {
  var sdk = loadSdk({
    url: LANDING,
    config: PIXEL_CONFIG,
    hspixel: function () { throw new Error('pixel blew up'); },
  });
  var sent = sdk.track('purchase', { amount: 5 });

  assert.strictEqual(sent.event_name, 'purchase');
});

test('the pixel id can come from the script tag attribute', function () {
  var sdk = loadSdk({
    url: LANDING,
    config: { token: 'test_token', spa: false, debug: false },
    scriptAttrs: { 'data-token': 'test_token', 'data-hotstar-pixel-id': 'px-attr' },
  });

  assert.deepStrictEqual(hotstarCalls(sdk)[0], ['init', 'px-attr']);
});
