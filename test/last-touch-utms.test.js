'use strict';

// LIN-2286 fix #4 — last-touch UTMs must survive a payment gateway round trip.
// Reproduces the Playo (project 193) case: the purchase fires on
// /confirmation?status=CHARGED with no UTMs in the URL and a gateway referrer, in what
// is often a fresh tab, so the sessionStorage-only last-touch state is gone.

var test = require('node:test');
var assert = require('node:assert');

var harness = require('./helpers/sdk-harness');
var loadSdk = harness.loadSdk;
var createClock = harness.createClock;
var createStorage = harness.createStorage;
var MINUTE = harness.MINUTE;
var HOUR = harness.HOUR;

var CAMPAIGN_URL =
  'https://playo.co/venues?utm_source=meta&utm_medium=cpc&utm_campaign=playo_aug_retarget' +
  '&utm_id=120210987654321&utm_content=carousel_a&fbclid=IwAR_first_click';

var UTM_ONLY_CAMPAIGN_URL =
  'https://playo.co/venues?utm_source=google&utm_medium=cpc&utm_campaign=brand_search&utm_id=99887';

var GATEWAY_RETURN_URL = 'https://playo.co/confirmation?status=CHARGED&order_id=OD9241';
var GATEWAY_REFERRER = 'https://payments.juspay.in/txns/redirect';

test('campaign UTMs survive a gateway round trip in a fresh tab', function () {
  var clock = createClock();
  var localStorage = createStorage();

  var landing = loadSdk({
    url: CAMPAIGN_URL,
    clock: clock,
    localStorage: localStorage,
    sessionStorage: createStorage(),
  });
  var landingView = landing.pageView();
  assert.strictEqual(landingView.utm_campaign, 'playo_aug_retarget');

  // Gateway sends the visitor back ~9 minutes later, new tab (empty sessionStorage).
  clock.advance(9 * MINUTE);
  var confirmation = loadSdk({
    url: GATEWAY_RETURN_URL,
    referrer: GATEWAY_REFERRER,
    clock: clock,
    localStorage: localStorage,
    sessionStorage: createStorage(),
  });
  var purchase = confirmation.track('purchase', { amount: 1200 });

  assert.strictEqual(purchase.utm_source, 'meta');
  assert.strictEqual(purchase.utm_medium, 'cpc');
  assert.strictEqual(purchase.utm_campaign, 'playo_aug_retarget');
  assert.strictEqual(purchase.utm_id, '120210987654321');
  assert.strictEqual(purchase.utm_content, 'carousel_a');
  assert.strictEqual(purchase.ft_utm_campaign, 'playo_aug_retarget');
  assert.strictEqual(purchase.ft_utm_id, '120210987654321');
  // Referrer reporting is untouched — only attribution inputs are restored.
  assert.strictEqual(purchase.referring_domain, 'payments.juspay.in');
});

test('UTM-only campaign is still classified as paid, not as a gateway referral', function () {
  var clock = createClock();
  var localStorage = createStorage();

  loadSdk({
    url: UTM_ONLY_CAMPAIGN_URL,
    clock: clock,
    localStorage: localStorage,
    sessionStorage: createStorage(),
  }).pageView();

  clock.advance(12 * MINUTE);
  var purchase = loadSdk({
    url: GATEWAY_RETURN_URL,
    referrer: GATEWAY_REFERRER,
    clock: clock,
    localStorage: localStorage,
    sessionStorage: createStorage(),
  }).track('purchase', { amount: 800 });

  assert.strictEqual(purchase.utm_campaign, 'brand_search');
  assert.strictEqual(purchase.traffic_source_type, 'paid_search');
  assert.strictEqual(purchase.traffic_source_name, 'google');
});

test('a new campaign click replaces the stored set instead of merging with it', function () {
  var clock = createClock();
  var localStorage = createStorage();
  var sessionStorage = createStorage();

  loadSdk({
    url: CAMPAIGN_URL,
    clock: clock,
    localStorage: localStorage,
    sessionStorage: sessionStorage,
  }).pageView();

  clock.advance(20 * MINUTE);
  var second = loadSdk({
    url: 'https://playo.co/offers?utm_source=google&utm_medium=cpc&utm_campaign=aug_search',
    clock: clock,
    localStorage: localStorage,
    sessionStorage: sessionStorage,
  });
  var view = second.pageView();

  assert.strictEqual(view.utm_source, 'google');
  assert.strictEqual(view.utm_campaign, 'aug_search');
  // Stale fields from the previous campaign must not ride along.
  assert.strictEqual(view.utm_id, '');
  assert.strictEqual(view.utm_content, '');
  // First-touch stays on the original campaign.
  assert.strictEqual(view.ft_utm_campaign, 'playo_aug_retarget');
  assert.strictEqual(view.ft_utm_content, 'carousel_a');
});

test('a new campaign click is never suppressed by stored values', function () {
  var clock = createClock();
  var localStorage = createStorage();
  var sessionStorage = createStorage();

  loadSdk({
    url: CAMPAIGN_URL,
    clock: clock,
    localStorage: localStorage,
    sessionStorage: sessionStorage,
  }).pageView();

  // Same tab, same session — the fresh URL still wins.
  clock.advance(2 * MINUTE);
  var view = loadSdk({
    url: 'https://playo.co/venues?utm_source=meta&utm_medium=cpc&utm_campaign=playo_sep_prospecting&utm_id=555',
    clock: clock,
    localStorage: localStorage,
    sessionStorage: sessionStorage,
  }).pageView();

  assert.strictEqual(view.utm_campaign, 'playo_sep_prospecting');
  assert.strictEqual(view.utm_id, '555');
});

test('referrer-only navigation does not overwrite or clear stored UTMs', function () {
  var clock = createClock();
  var localStorage = createStorage();

  loadSdk({
    url: CAMPAIGN_URL,
    clock: clock,
    localStorage: localStorage,
    sessionStorage: createStorage(),
  }).pageView();

  clock.advance(3 * MINUTE);
  var view = loadSdk({
    url: 'https://playo.co/checkout',
    referrer: 'https://www.google.com/',
    clock: clock,
    localStorage: localStorage,
    sessionStorage: createStorage(),
  }).pageView();

  assert.strictEqual(view.utm_campaign, 'playo_aug_retarget');
  assert.strictEqual(view.traffic_source_type, 'paid_social');
  assert.strictEqual(view.traffic_source_name, 'meta');
});

test('a new click ID with no UTMs clears the previous campaign UTMs', function () {
  var clock = createClock();
  var localStorage = createStorage();
  var sessionStorage = createStorage();

  loadSdk({
    url: CAMPAIGN_URL,
    clock: clock,
    localStorage: localStorage,
    sessionStorage: sessionStorage,
  }).pageView();

  clock.advance(30 * MINUTE);
  var view = loadSdk({
    url: 'https://playo.co/venues?fbclid=IwAR_second_click',
    clock: clock,
    localStorage: localStorage,
    sessionStorage: sessionStorage,
  }).pageView();

  assert.strictEqual(view.utm_campaign, '');
  assert.strictEqual(view.utm_id, '');
  assert.strictEqual(view.traffic_source_type, 'paid_social');
  assert.strictEqual(view.fbclid, 'IwAR_second_click');
});

test('a repeated click ID (same value) does not clear stored UTMs', function () {
  var clock = createClock();
  var localStorage = createStorage();

  loadSdk({
    url: CAMPAIGN_URL,
    clock: clock,
    localStorage: localStorage,
    sessionStorage: createStorage(),
  }).pageView();

  clock.advance(5 * MINUTE);
  var view = loadSdk({
    url: 'https://playo.co/confirmation?status=CHARGED&fbclid=IwAR_first_click',
    referrer: GATEWAY_REFERRER,
    clock: clock,
    localStorage: localStorage,
    sessionStorage: createStorage(),
  }).pageView();

  assert.strictEqual(view.utm_campaign, 'playo_aug_retarget');
});

test('stored UTMs expire 24 hours after the campaign click', function () {
  var clock = createClock();
  var localStorage = createStorage();

  loadSdk({
    url: CAMPAIGN_URL,
    clock: clock,
    localStorage: localStorage,
    sessionStorage: createStorage(),
  }).pageView();

  clock.advance(24 * HOUR + MINUTE);
  var view = loadSdk({
    url: 'https://playo.co/venues',
    clock: clock,
    localStorage: localStorage,
    sessionStorage: createStorage(),
  }).pageView();

  assert.strictEqual(view.utm_campaign, '');
  assert.strictEqual(view.utm_source, '');
  assert.strictEqual(localStorage.getItem('lr_lt'), null);
  // First-touch and click IDs keep their own, longer lifetimes.
  assert.strictEqual(view.ft_utm_campaign, 'playo_aug_retarget');
  assert.strictEqual(view.fbclid, 'IwAR_first_click');
});

test('a long browse-then-buy journey inside 24 hours keeps its UTMs', function () {
  var clock = createClock();
  var localStorage = createStorage();

  var landing = loadSdk({
    url: CAMPAIGN_URL,
    clock: clock,
    localStorage: localStorage,
    sessionStorage: createStorage(),
  });
  landing.pageView();

  clock.advance(6 * HOUR);
  var view = loadSdk({
    url: GATEWAY_RETURN_URL,
    referrer: GATEWAY_REFERRER,
    clock: clock,
    localStorage: localStorage,
    sessionStorage: createStorage(),
  }).pageView();

  assert.strictEqual(view.utm_campaign, 'playo_aug_retarget');
});

test('the cap also applies to a tab that stays open past 24 hours', function () {
  var clock = createClock();
  var localStorage = createStorage();
  var sessionStorage = createStorage();

  var visit = loadSdk({
    url: CAMPAIGN_URL,
    clock: clock,
    localStorage: localStorage,
    sessionStorage: sessionStorage,
  });
  visit.pageView();

  clock.advance(23 * HOUR);
  assert.strictEqual(visit.track('heartbeat', null).utm_campaign, 'playo_aug_retarget');

  clock.advance(2 * HOUR);
  assert.strictEqual(visit.track('purchase', { amount: 1200 }).utm_campaign, '');
  // The sessionStorage mirror is cleared too, so an open tab cannot outlive the window.
  assert.strictEqual(sessionStorage.getItem('lr_utm_campaign'), null);
});

test('localStorage failures degrade to the previous sessionStorage behaviour', function () {
  var clock = createClock();
  var localStorage = createStorage();
  localStorage.failReads = true;
  localStorage.failWrites = true;
  var sessionStorage = createStorage();

  var landing = loadSdk({
    url: CAMPAIGN_URL,
    clock: clock,
    localStorage: localStorage,
    sessionStorage: sessionStorage,
  });
  var view = landing.pageView();

  // Tracking still works and last-touch attribution still holds inside the tab.
  assert.strictEqual(view.event_type, 'page_view');
  assert.strictEqual(view.utm_campaign, 'playo_aug_retarget');
  assert.strictEqual(view.ft_utm_campaign, '');

  clock.advance(4 * MINUTE);
  var purchase = loadSdk({
    url: GATEWAY_RETURN_URL,
    referrer: GATEWAY_REFERRER,
    clock: clock,
    localStorage: localStorage,
    sessionStorage: sessionStorage,
  }).track('purchase', { amount: 1200 });

  assert.strictEqual(purchase.utm_campaign, 'playo_aug_retarget');
  assert.strictEqual(purchase.event_name, 'purchase');
});

test('legacy sessionStorage-only state keeps working after upgrade', function () {
  var clock = createClock();
  // A visitor mid-session on the previous SDK build: UTMs in sessionStorage, no lr_lt.
  var sessionStorage = createStorage({
    lr_sid: 'legacy-session',
    lr_utm_source: 'meta',
    lr_utm_medium: 'cpc',
    lr_utm_campaign: 'legacy_campaign',
    lr_utm_id: '4242',
  });
  var localStorage = createStorage({ lr_vid: 'legacy-visitor' });

  var view = loadSdk({
    url: GATEWAY_RETURN_URL,
    referrer: GATEWAY_REFERRER,
    clock: clock,
    localStorage: localStorage,
    sessionStorage: sessionStorage,
  }).pageView();

  assert.strictEqual(view.utm_campaign, 'legacy_campaign');
  assert.strictEqual(view.utm_id, '4242');
  assert.strictEqual(view.traffic_source_type, 'paid_search');
  assert.strictEqual(view.visitor_id, 'legacy-visitor');
  assert.strictEqual(localStorage.getItem('lr_lt'), null);
});

test('a visitor with no campaign history is unaffected', function () {
  var view = loadSdk({
    url: 'https://playo.co/',
    referrer: 'https://www.google.com/',
    clock: createClock(),
    localStorage: createStorage(),
    sessionStorage: createStorage(),
  }).pageView();

  assert.strictEqual(view.utm_campaign, '');
  assert.strictEqual(view.traffic_source_type, 'organic_search');
  assert.strictEqual(view.traffic_source_name, 'google');
});
