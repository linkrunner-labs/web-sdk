'use strict';

// LIN-3622: every network's click id is stored on its own for 90 days, and the source
// used to come from a fixed order with Google first. A visitor who clicked a Google ad
// and then a Meta ad was still reported as Google, on the Google click's campaign. The
// last ad click now decides the source, whichever network it came from.

var test = require('node:test');
var assert = require('node:assert');

var harness = require('./helpers/sdk-harness');
var loadSdk = harness.loadSdk;
var createClock = harness.createClock;
var createStorage = harness.createStorage;
var MINUTE = harness.MINUTE;
var HOUR = harness.HOUR;
var DAY = 24 * HOUR;

var GOOGLE_LANDING = 'https://shop.example.com/?gad_source=1&gad_campaignid=111&gclid=Cj0_google_click';
var SECOND_GOOGLE_LANDING = 'https://shop.example.com/?gad_source=1&gad_campaignid=222&gclid=Cj0_second_click';
var META_LANDING = 'https://shop.example.com/?fbclid=IwAR_meta_click';
var META_LANDING_WITH_UTMS =
  'https://shop.example.com/?utm_source=facebook&utm_medium=paid_social&utm_campaign=spring&fbclid=IwAR_meta_click';
var RETURN_URL = 'https://shop.example.com/confirmation?order_id=OD1';
var GATEWAY_REFERRER = 'https://payments.juspay.in/txns/redirect';
var PLAIN_PAGE = 'https://shop.example.com/products';

// One page load per call, sharing localStorage like one visitor in fresh tabs.
function visitor(options) {
  options = options || {};
  var clock = createClock();
  var localStorage = createStorage(options.storage && options.storage(clock.now));
  return {
    clock: clock,
    localStorage: localStorage,
    // Each load is a fresh tab unless the caller passes the tab's own sessionStorage.
    load: function (url, referrer, sessionStorage) {
      return loadSdk({
        url: url,
        referrer: referrer,
        clock: clock,
        localStorage: localStorage,
        sessionStorage: sessionStorage || createStorage(),
        cookie: options.cookie,
      });
    },
  };
}

function stored(value, t) {
  return JSON.stringify({ v: value, t: t });
}

test('a Meta click after a Google click is attributed to Meta, through to the purchase', function () {
  var v = visitor();
  v.load(GOOGLE_LANDING).pageView();
  v.clock.advance(3 * DAY);
  var landing = v.load(META_LANDING).pageView();
  v.clock.advance(10 * MINUTE);
  var purchase = v.load(RETURN_URL, GATEWAY_REFERRER).track('purchase', { amount: 1200 });

  [landing, purchase].forEach(function (event) {
    assert.strictEqual(event.traffic_source_type, 'paid_social');
    assert.strictEqual(event.traffic_source_name, 'meta');
    // Google's postback still needs its click id; the campaign is not last touch.
    assert.strictEqual(event.gclid, 'Cj0_google_click');
    assert.strictEqual(event.fbclid, 'IwAR_meta_click');
    assert.strictEqual(event.gad_campaignid, '');
    // First touch is untouched.
    assert.strictEqual(event.ft_gclid, 'Cj0_google_click');
    assert.strictEqual(event.ft_gad_campaignid, '111');
    assert.strictEqual(event.ft_traffic_source_name, 'google');
  });
});

test('a Meta click with UTMs stays Meta after its UTMs expire', function () {
  var v = visitor();
  v.load(GOOGLE_LANDING).pageView();
  v.clock.advance(3 * DAY);
  v.load(META_LANDING_WITH_UTMS).pageView();
  v.clock.advance(2 * DAY);
  var purchase = v.load(PLAIN_PAGE).track('purchase', { amount: 1200 });

  assert.strictEqual(purchase.utm_source, '');
  assert.strictEqual(purchase.traffic_source_name, 'meta');
  assert.strictEqual(purchase.gad_campaignid, '');
});

test('a Google click after a Meta click is attributed to Google with its campaign', function () {
  var v = visitor();
  v.load(META_LANDING).pageView();
  v.clock.advance(3 * DAY);
  var view = v.load(GOOGLE_LANDING).pageView();

  assert.strictEqual(view.traffic_source_type, 'paid_search');
  assert.strictEqual(view.traffic_source_name, 'google');
  assert.strictEqual(view.gad_campaignid, '111');
  assert.strictEqual(view.fbclid, 'IwAR_meta_click');
});

test('a new Google click after the Meta click takes last touch with its own campaign', function () {
  var v = visitor();
  v.load(GOOGLE_LANDING).pageView();
  v.clock.advance(DAY);
  v.load(META_LANDING).pageView();
  v.clock.advance(DAY);
  var view = v.load(SECOND_GOOGLE_LANDING).pageView();

  assert.strictEqual(view.traffic_source_name, 'google');
  assert.strictEqual(view.gclid, 'Cj0_second_click');
  assert.strictEqual(view.gad_campaignid, '222');
});

test('reloading an earlier ad landing is not a new click', function () {
  var v = visitor();
  v.load(GOOGLE_LANDING).pageView();
  v.clock.advance(3 * DAY);
  v.load(META_LANDING).pageView();
  // A restored tab still on the Google landing URL, a day after the Meta click.
  v.clock.advance(DAY);
  var view = v.load(GOOGLE_LANDING).pageView();

  assert.strictEqual(view.traffic_source_name, 'meta');
  assert.strictEqual(view.gad_campaignid, '');
});

test('a reload does not extend the click past 90 days from the click', function () {
  var v = visitor();
  v.load(GOOGLE_LANDING).pageView();
  v.clock.advance(60 * DAY);
  v.load(GOOGLE_LANDING).pageView();
  v.clock.advance(31 * DAY);
  var view = v.load(PLAIN_PAGE).pageView();

  assert.strictEqual(view.gclid, '');
  assert.strictEqual(view.gad_campaignid, '');
  assert.strictEqual(view.traffic_source_type, 'direct');
  // The campaign is stored with the click and expires with it.
  assert.strictEqual(v.localStorage.getItem('lr_gad_campaignid'), null);
});

test('reloading an earlier ad landing keeps the last click\'s UTMs', function () {
  var v = visitor();
  v.load('https://shop.example.com/?utm_source=google&utm_medium=cpc&utm_campaign=brand_search&gclid=Cj0_google_click').pageView();
  v.clock.advance(DAY);
  v.load(META_LANDING_WITH_UTMS).pageView();
  v.clock.advance(HOUR);
  var view = v.load('https://shop.example.com/?utm_source=google&utm_medium=cpc&utm_campaign=brand_search&gclid=Cj0_google_click').pageView();

  assert.strictEqual(view.traffic_source_name, 'meta');
  assert.strictEqual(view.utm_source, 'facebook');
  assert.strictEqual(view.utm_campaign, 'spring');
});

test('reloading an earlier Meta landing does not bring its UTMs back after a Google click', function () {
  var v = visitor();
  v.load(META_LANDING_WITH_UTMS).pageView();
  v.clock.advance(DAY);
  v.load(GOOGLE_LANDING).pageView();
  v.clock.advance(HOUR);
  var view = v.load(META_LANDING_WITH_UTMS).pageView();

  assert.strictEqual(view.traffic_source_name, 'google');
  assert.strictEqual(view.utm_source, '');
  assert.strictEqual(view.gad_campaignid, '111');
});

test('a tab still open on an earlier landing does not bring its UTMs back', function () {
  var v = visitor();
  var googleTab = createStorage();
  v.load('https://shop.example.com/?utm_source=google&utm_medium=cpc&utm_campaign=brand_search&gclid=Cj0_google_click', '', googleTab).pageView();
  v.clock.advance(HOUR);
  v.load(META_LANDING).pageView();
  v.clock.advance(HOUR);
  var view = v.load(PLAIN_PAGE, '', googleTab).track('purchase', { amount: 1200 });

  assert.strictEqual(view.traffic_source_name, 'meta');
  assert.strictEqual(view.utm_source, '');
  assert.strictEqual(view.utm_campaign, '');
});

test('a tab still open on an earlier Meta landing does not relabel a later Google click', function () {
  var v = visitor();
  var metaTab = createStorage();
  v.load(META_LANDING_WITH_UTMS, '', metaTab).pageView();
  v.clock.advance(HOUR);
  v.load(GOOGLE_LANDING).pageView();
  v.clock.advance(HOUR);
  var view = v.load(META_LANDING_WITH_UTMS, '', metaTab).pageView();

  assert.strictEqual(view.traffic_source_name, 'google');
  assert.strictEqual(view.utm_source, '');
  assert.strictEqual(view.gad_campaignid, '111');
});

test('a tab left open past 24 hours does not bring its UTMs back once another tab expires them', function () {
  var v = visitor();
  var googleTab = createStorage();
  v.load('https://shop.example.com/?utm_source=google&utm_medium=cpc&utm_campaign=brand_search&gclid=Cj0_google_click', '', googleTab).pageView();
  v.clock.advance(HOUR);
  v.load(META_LANDING).pageView();
  // A day later another tab is the one that finds the record expired and removes it.
  v.clock.advance(25 * HOUR);
  v.load(PLAIN_PAGE).pageView();
  var view = v.load(PLAIN_PAGE, '', googleTab).track('purchase', { amount: 1200 });

  assert.strictEqual(view.traffic_source_name, 'meta');
  assert.strictEqual(view.utm_source, '');
  assert.strictEqual(view.utm_campaign, '');
});

test('reloading the last click\'s landing refreshes its UTMs even when it also carries an older click id', function () {
  var v = visitor();
  var url = 'https://shop.example.com/?utm_source=google&utm_medium=cpc&utm_campaign=brand_search&gclid=Cj0_google_click&fbclid=IwAR_meta_click';
  v.load(META_LANDING).pageView();
  v.clock.advance(HOUR);
  v.load(url).pageView();
  v.clock.advance(25 * HOUR);
  var view = v.load(url).pageView();

  assert.strictEqual(view.traffic_source_name, 'google');
  assert.strictEqual(view.utm_campaign, 'brand_search');
});

test('reloading the last click\'s own landing still refreshes its UTMs', function () {
  var v = visitor();
  v.load(META_LANDING_WITH_UTMS).pageView();
  v.clock.advance(25 * HOUR);
  var view = v.load(META_LANDING_WITH_UTMS).pageView();

  assert.strictEqual(view.traffic_source_name, 'meta');
  assert.strictEqual(view.utm_campaign, 'spring');
});

test('one landing carrying two networks\' ids keeps the fixed order', function () {
  var v = visitor();
  var view = v.load('https://shop.example.com/?gad_campaignid=111&gclid=Cj0_google_click&fbclid=IwAR_share').pageView();

  assert.strictEqual(view.traffic_source_name, 'google');
  assert.strictEqual(view.gad_campaignid, '111');
});

test('click ids stored by an earlier SDK version are ranked by their click time', function () {
  var v = visitor({
    storage: function (now) {
      return {
        lr_gclid: stored('Cj0_google_click', now - 3 * DAY),
        lr_gad_campaignid: stored('111', now - 3 * DAY),
        lr_fbclid: stored('IwAR_meta_click', now - DAY),
      };
    },
  });
  var view = v.load(PLAIN_PAGE).pageView();

  assert.strictEqual(view.traffic_source_name, 'meta');
  assert.strictEqual(view.gclid, 'Cj0_google_click');
  assert.strictEqual(view.gad_campaignid, '');
});

test('ids an earlier SDK version stored from one landing, a millisecond apart, are one click', function () {
  var v = visitor({
    storage: function (now) {
      return {
        lr_gclid: stored('Cj0_google_click', now - DAY),
        lr_gad_campaignid: stored('111', now - DAY),
        lr_fbclid: stored('IwAR_share', now - DAY + 1),
      };
    },
  });
  var view = v.load(PLAIN_PAGE).pageView();

  assert.strictEqual(view.traffic_source_name, 'google');
  assert.strictEqual(view.gad_campaignid, '111');
});

test('Meta pixel cookies copied on every page view do not outrank the last click', function () {
  var v = visitor({ cookie: '_fbp=fb.1.1700000000000.123; _fbc=fb.1.1700000000000.IwAR_old' });
  v.load(GOOGLE_LANDING).pageView();
  v.clock.advance(DAY);
  var view = v.load(PLAIN_PAGE).pageView();

  assert.strictEqual(view.fbp, 'fb.1.1700000000000.123');
  assert.strictEqual(view.traffic_source_name, 'google');
  assert.strictEqual(view.gad_campaignid, '111');
});

test('the last click decides between the other networks too', function () {
  var v = visitor();
  v.load(META_LANDING).pageView();
  v.clock.advance(DAY);
  var view = v.load('https://shop.example.com/?oppref=chatgpt_click').pageView();

  assert.strictEqual(view.traffic_source_type, 'paid_search');
  assert.strictEqual(view.traffic_source_name, 'chatgpt');
  assert.strictEqual(view.fbclid, 'IwAR_meta_click');
});

test('the Shopify context record follows the last click', function () {
  var v = visitor();
  v.load(GOOGLE_LANDING).pageView();
  v.clock.advance(DAY);
  v.load(META_LANDING).pageView();

  var ctx = JSON.parse(v.localStorage.getItem('lr_ctx'));
  assert.strictEqual(ctx.fields.traffic_source_name, 'meta');
  assert.strictEqual(ctx.fields.gclid, 'Cj0_google_click');
  assert.strictEqual(ctx.fields.gad_campaignid, '');
  assert.strictEqual(ctx.fields.ft_gad_campaignid, '111');
});
