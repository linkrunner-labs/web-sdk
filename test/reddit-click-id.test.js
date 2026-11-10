'use strict';

// LIN-3940 — Reddit's click id is captured nowhere today: not in web_events, not on
// the click row, not here. Without it a web conversion has nothing for Reddit's
// Conversions API to match on (`click_id`).
//
// Unlike Snapchat's `ScCid`, Reddit spells it `rdt_cid` on the URL, which is already
// the storage key, so it needs no alias. These tests pin that it rides the ordinary
// path: persisted last touch, written first touch, and still present on a conversion
// that fires on a later page.

var test = require('node:test');
var assert = require('node:assert');

var harness = require('./helpers/sdk-harness');
var loadSdk = harness.loadSdk;
var createClock = harness.createClock;
var createStorage = harness.createStorage;
var MINUTE = harness.MINUTE;

var REDDIT_LANDING = 'https://shop.example/offers?utm_source=reddit&rdt_cid=rdt_click_abc123';
var GATEWAY_RETURN_URL = 'https://shop.example/thanks?status=CHARGED&order_id=OD771';
var GATEWAY_REFERRER = 'https://payments.juspay.in/txns/redirect';

function visitor() {
  var clock = createClock();
  var localStorage = createStorage();
  return {
    clock: clock,
    load: function (url, referrer) {
      return loadSdk({
        url: url,
        referrer: referrer,
        clock: clock,
        localStorage: localStorage,
        sessionStorage: createStorage(),
      });
    },
  };
}

test('rdt_cid on the landing URL is captured last touch and first touch', function () {
  var landing = visitor().load(REDDIT_LANDING).pageView();

  assert.strictEqual(landing.rdt_cid, 'rdt_click_abc123');
  assert.strictEqual(landing.ft_rdt_cid, 'rdt_click_abc123');
});

test('the Reddit click id reaches a purchase on the gateway return page', function () {
  // The conversion that matters fires after a payment gateway round trip, on a URL
  // carrying no click id of its own. Reddit's own docs recommend sending the landing
  // URL with the click id appended for match rate, which is only possible because
  // the id is persisted here.
  var v = visitor();
  v.load(REDDIT_LANDING).pageView();

  v.clock.advance(11 * MINUTE);
  var purchase = v.load(GATEWAY_RETURN_URL, GATEWAY_REFERRER).track('purchase', { amount: 980 });

  assert.strictEqual(purchase.rdt_cid, 'rdt_click_abc123');
  assert.strictEqual(purchase.ft_rdt_cid, 'rdt_click_abc123');
});

test('a Reddit click is paid traffic, like every other click id', function () {
  // Without a rung in classifyTrafficSource a Reddit click read as direct/direct, or
  // as organic social when the referrer survived, so the paid visit was invisible as
  // paid. Nothing server side could promote it: the declared-paid-social reclassifier
  // needs type "social" AND utm_medium=paid_social, and no reclassifier reads a
  // click id.
  var landing = visitor().load('https://shop.example/offers?rdt_cid=rdt_paid_1').pageView();

  assert.strictEqual(landing.traffic_source_type, 'paid_social');
  assert.strictEqual(landing.traffic_source_name, 'reddit');
});

test('a click id already on the URL still wins over the Reddit one', function () {
  // The rung is last, so adding it cannot change how a URL carrying two click ids
  // already resolved.
  var landing = visitor()
    .load('https://shop.example/offers?rdt_cid=rdt_1&ttclid=tt_1')
    .pageView();

  assert.strictEqual(landing.traffic_source_name, 'tiktok');
});

test('a landing page with no Reddit click id sends an empty rdt_cid', function () {
  // The column exists on every row, so an absent id must be '' rather than
  // undefined, or the collector writes nothing for it.
  var landing = visitor().load('https://shop.example/offers?utm_source=newsletter').pageView();

  assert.strictEqual(landing.rdt_cid, '');
  assert.strictEqual(landing.ft_rdt_cid, '');
});

test('a Reddit click does not disturb the Snapchat click id', function () {
  // Both were added in the same release window and share the persistence loop, so
  // this pins that CLICK_ID_KEYS entries stay independent of one another.
  var landing = visitor()
    .load('https://shop.example/offers?rdt_cid=rdt_1&ScCid=sc_1')
    .pageView();

  assert.strictEqual(landing.rdt_cid, 'rdt_1');
  assert.strictEqual(landing.sccid, 'sc_1');
});
