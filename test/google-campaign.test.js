'use strict';

// LIN-3485 — Google auto-tagging puts gad_campaignid on the landing URL only. Playo's
// purchases fire on /confirmation after a payment gateway, so without persisting it the
// purchase carries the gclid but no Google campaign, and the Channel tab's Google drill
// shows every campaign at zero purchases.

var test = require('node:test');
var assert = require('node:assert');

var harness = require('./helpers/sdk-harness');
var loadSdk = harness.loadSdk;
var createClock = harness.createClock;
var createStorage = harness.createStorage;
var MINUTE = harness.MINUTE;

var BOF_LANDING =
  'https://playo.co/venues?utm_source=google&utm_campaign=BOF-Search-Booking-Event' +
  '&gad_source=1&gad_campaignid=22329341502&gclid=Cj0_bof_click';
var TOF_LANDING = 'https://playo.co/venues?gad_source=1&gad_campaignid=24137000536&gclid=Cj0_tof_click';
var GATEWAY_RETURN_URL = 'https://playo.co/confirmation?status=CHARGED&order_id=OD9241';
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

test('the Google campaign id reaches a purchase on the gateway return page', function () {
  var v = visitor();
  var landing = v.load(BOF_LANDING).pageView();
  assert.strictEqual(landing.gad_campaignid, '22329341502');

  v.clock.advance(9 * MINUTE);
  var purchase = v.load(GATEWAY_RETURN_URL, GATEWAY_REFERRER).track('purchase', { amount: 1200 });

  assert.strictEqual(purchase.gclid, 'Cj0_bof_click');
  assert.strictEqual(purchase.gad_campaignid, '22329341502');
  assert.strictEqual(purchase.ft_gad_campaignid, '22329341502');
});

test('a new Google click replaces the campaign id', function () {
  var v = visitor();
  v.load(BOF_LANDING).pageView();
  v.clock.advance(MINUTE);
  var view = v.load(TOF_LANDING).pageView();

  assert.strictEqual(view.gclid, 'Cj0_tof_click');
  assert.strictEqual(view.gad_campaignid, '24137000536');
  // First touch keeps the first Google click's campaign, alongside its ft_gclid.
  assert.strictEqual(view.ft_gclid, 'Cj0_bof_click');
  assert.strictEqual(view.ft_gad_campaignid, '22329341502');
});

test('a new Google click without a campaign id clears the previous one', function () {
  var v = visitor();
  v.load(BOF_LANDING).pageView();
  v.clock.advance(MINUTE);
  var view = v.load('https://playo.co/venues?gclid=Cj0_untagged_click').pageView();

  assert.strictEqual(view.gclid, 'Cj0_untagged_click');
  assert.strictEqual(view.gad_campaignid, '');
});

test('first touch takes the campaign id only from the first Google click', function () {
  var v = visitor();
  v.load('https://playo.co/venues?gclid=Cj0_untagged_click').pageView();
  v.clock.advance(MINUTE);
  var view = v.load(BOF_LANDING).pageView();

  assert.strictEqual(view.gad_campaignid, '22329341502');
  assert.strictEqual(view.ft_gclid, 'Cj0_untagged_click');
  assert.strictEqual(view.ft_gad_campaignid, '');
});

test('a campaign id with no Google click is not persisted', function () {
  var v = visitor();
  var view = v.load('https://playo.co/venues?gad_campaignid=22329341502').pageView();

  assert.strictEqual(view.gad_campaignid, '');
  assert.strictEqual(view.ft_gad_campaignid, '');
});

test('a later non-Google click keeps the gclid but not its campaign as last touch', function () {
  var v = visitor();
  v.load(BOF_LANDING).pageView();
  v.clock.advance(MINUTE);
  var view = v.load('https://playo.co/venues?fbclid=IwAR_meta_click').pageView();

  // The gclid is still sent for Google's postback, but the Meta click is the last
  // click now (LIN-3622), so the Google campaign is not last touch any more.
  assert.strictEqual(view.traffic_source_name, 'meta');
  assert.strictEqual(view.gclid, 'Cj0_bof_click');
  assert.strictEqual(view.gad_campaignid, '');
  assert.strictEqual(view.ft_gad_campaignid, '22329341502');
});

test('the campaign id expires with the click, after 90 days', function () {
  var v = visitor();
  v.load(BOF_LANDING).pageView();
  v.clock.advance(91 * 24 * 60 * MINUTE);
  var view = v.load(GATEWAY_RETURN_URL).pageView();

  assert.strictEqual(view.gclid, '');
  assert.strictEqual(view.gad_campaignid, '');
  assert.strictEqual(v.localStorage.getItem('lr_gad_campaignid'), null);
});

test('the Shopify context record carries the campaign id', function () {
  var v = visitor();
  v.load(BOF_LANDING).pageView();

  var ctx = JSON.parse(v.localStorage.getItem('lr_ctx'));
  assert.strictEqual(ctx.fields.gad_campaignid, '22329341502');
  assert.strictEqual(ctx.fields.ft_gad_campaignid, '22329341502');
});
