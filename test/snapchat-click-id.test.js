'use strict';

// LIN-3939 — Snapchat appends its click id to an ad's landing URL as `ScCid`, and query
// params are read case-sensitively, so the capture loop needs an alias for it. Without
// one the id is simply never stored, and a web conversion sent to the Snapchat
// Conversions API has no sc_click_id to match on.

var test = require('node:test');
var assert = require('node:assert');

var harness = require('./helpers/sdk-harness');
var loadSdk = harness.loadSdk;
var createClock = harness.createClock;
var createStorage = harness.createStorage;
var MINUTE = harness.MINUTE;

var SNAP_LANDING = 'https://shop.example/offers?utm_source=snapchat&ScCid=sc_click_abc123';
var GATEWAY_RETURN_URL = 'https://shop.example/thanks?status=CHARGED&order_id=OD551';
var GATEWAY_REFERRER = 'https://payments.juspay.in/txns/redirect';

// One page load per call, sharing localStorage like one visitor in fresh tabs.
function visitor() {
  var clock = createClock();
  var localStorage = createStorage();
  return {
    clock: clock,
    localStorage: localStorage,
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

test('ScCid on the landing URL is captured as sccid and ft_sccid', function () {
  var landing = visitor().load(SNAP_LANDING).pageView();

  assert.strictEqual(landing.sccid, 'sc_click_abc123');
  assert.strictEqual(landing.ft_sccid, 'sc_click_abc123');
});

test('the Snapchat click id reaches a purchase on the gateway return page', function () {
  // The conversion that matters fires after a payment gateway round trip, on a URL
  // that carries no click id of its own. That is the whole reason the SDK persists it.
  var v = visitor();
  v.load(SNAP_LANDING).pageView();

  v.clock.advance(9 * MINUTE);
  var purchase = v.load(GATEWAY_RETURN_URL, GATEWAY_REFERRER).track('purchase', { amount: 1200 });

  assert.strictEqual(purchase.sccid, 'sc_click_abc123');
  assert.strictEqual(purchase.ft_sccid, 'sc_click_abc123');
});

test('a lowercase sccid param is captured too', function () {
  // Not Snapchat's own spelling, but a hand-built link or a tool that normalised the
  // case should not silently lose the id.
  var landing = visitor().load('https://shop.example/offers?sccid=sc_lower_1').pageView();

  assert.strictEqual(landing.sccid, 'sc_lower_1');
});

test('any casing of the param is captured, not just the four that were listed', function () {
  // The alias list used to enumerate spellings, which covered four of the thirty-two
  // ways "sccid" can be cased and missed Sccid and SCCid, no less likely than SCCID.
  ['ScCid', 'sccid', 'SCCID', 'Sccid', 'SCCid', 'scCid', 'ScCID'].forEach(function (name) {
    var landing = visitor()
      .load('https://shop.example/offers?' + name + '=sc_case_1')
      .pageView();

    assert.strictEqual(landing.sccid, 'sc_case_1', name + ' should be captured');
  });
});

test('a Snapchat click is paid traffic, like every other click id', function () {
  // A Snap click usually arrives from the in-app webview with no referrer. Without a
  // rung in classifyTrafficSource it read as direct/direct, so a paid visit was
  // invisible as paid, and nothing server side could fix it: the declared-paid-social
  // reclassifier needs type "social" AND utm_medium=paid_social, and no reclassifier
  // reads a click id.
  var landing = visitor().load('https://shop.example/offers?ScCid=sc_paid_1').pageView();

  assert.strictEqual(landing.traffic_source_type, 'paid_social');
  assert.strictEqual(landing.traffic_source_name, 'snapchat');
});

test('a click id already on the URL still wins over the Snapchat one', function () {
  // The rung is last, so adding it cannot change how a URL carrying two click ids
  // already resolved.
  var landing = visitor()
    .load('https://shop.example/offers?ScCid=sc_1&ttclid=tt_1')
    .pageView();

  assert.strictEqual(landing.traffic_source_name, 'tiktok');
});

test('a landing page with no Snapchat click id sends an empty sccid', function () {
  // Every other click id behaves this way: the column exists on every row, so an
  // absent id must be '' rather than undefined, or the collector writes nothing.
  var landing = visitor().load('https://shop.example/offers?utm_source=newsletter').pageView();

  assert.strictEqual(landing.sccid, '');
  assert.strictEqual(landing.ft_sccid, '');
});
