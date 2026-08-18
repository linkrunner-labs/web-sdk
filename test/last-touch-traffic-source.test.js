'use strict';

// The SDK recomputes the last-touch traffic source on every event and used to keep it
// only in the outgoing payload. A Shopify custom pixel runs sandboxed on the checkout
// page and can only READ storage. It cannot call into the SDK, so it had to re-derive
// the classification by hand and could not reproduce the referrer-based branch. These
// tests pin the stored values to exactly what the SDK reports, so the pixel can read
// them instead of guessing.

var test = require('node:test');
var assert = require('node:assert');

var harness = require('./helpers/sdk-harness');
var loadSdk = harness.loadSdk;
var createClock = harness.createClock;
var createStorage = harness.createStorage;

// fbclid is what makes this paid_social; utm_medium=cpc alone classifies as paid_search.
var PAID_SOCIAL_URL =
  'https://sidsfarm.com/?utm_source=meta&utm_medium=cpc&utm_campaign=aug_ghee&fbclid=IwAR_test';
var ORGANIC_URL = 'https://sidsfarm.com/collections/ghee';
var GOOGLE_REFERRER = 'https://www.google.com/';

test('last-touch traffic source is stored and matches the reported payload', function () {
  var sessionStorage = createStorage();

  var sdk = loadSdk({
    url: PAID_SOCIAL_URL,
    clock: createClock(),
    localStorage: createStorage(),
    sessionStorage: sessionStorage,
  });
  var view = sdk.pageView();

  assert.strictEqual(view.traffic_source_type, 'paid_social');
  assert.strictEqual(view.traffic_source_name, 'meta');
  // Parity: what a reader of storage sees must equal what the SDK sent.
  assert.strictEqual(sessionStorage.getItem('lr_ts_type'), view.traffic_source_type);
  assert.strictEqual(sessionStorage.getItem('lr_ts_name'), view.traffic_source_name);
});

test('a referral source is stored: the branch a storage reader cannot re-derive', function () {
  var sessionStorage = createStorage();

  var sdk = loadSdk({
    url: ORGANIC_URL,
    referrer: GOOGLE_REFERRER,
    clock: createClock(),
    localStorage: createStorage(),
    sessionStorage: sessionStorage,
  });
  var view = sdk.pageView();

  // The checkout page's referrer is the store itself, so a pixel re-deriving this
  // would fall through to "direct" and misattribute the purchase.
  assert.strictEqual(view.traffic_source_type, 'organic_search');
  assert.strictEqual(sessionStorage.getItem('lr_ts_type'), 'organic_search');
  assert.strictEqual(sessionStorage.getItem('lr_ts_name'), view.traffic_source_name);
});

test('first-touch is preserved and the stored value tracks the payload on return visits', function () {
  var clock = createClock();
  var localStorage = createStorage();
  var sessionStorage = createStorage();

  var paid = loadSdk({
    url: PAID_SOCIAL_URL,
    clock: clock,
    localStorage: localStorage,
    sessionStorage: sessionStorage,
  });
  paid.pageView();

  assert.strictEqual(localStorage.getItem('lr_ft_traffic_source_type'), 'paid_social');
  assert.strictEqual(sessionStorage.getItem('lr_ts_type'), 'paid_social');

  // Same visitor returns 2 hours later in a fresh tab, arriving via Google.
  clock.advance(2 * harness.HOUR);
  var returnSession = createStorage();
  var organic = loadSdk({
    url: ORGANIC_URL,
    referrer: GOOGLE_REFERRER,
    clock: clock,
    localStorage: localStorage,
    sessionStorage: returnSession,
  });
  var later = organic.pageView();

  // First touch is set-once and must not be overwritten.
  assert.strictEqual(localStorage.getItem('lr_ft_traffic_source_type'), 'paid_social');
  assert.strictEqual(later.ft_traffic_source_type, 'paid_social');

  // Last touch stays paid_social: the fbclid lives in localStorage for 90 days and
  // outranks the referrer in the classifier, so the ad keeps the credit. The point of
  // this assertion is parity: whatever the SDK decides, storage says the same thing.
  assert.strictEqual(returnSession.getItem('lr_ts_type'), later.traffic_source_type);
  assert.strictEqual(returnSession.getItem('lr_ts_name'), later.traffic_source_name);
});
