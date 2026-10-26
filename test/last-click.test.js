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

test('reloading the last click\'s landing within 24 hours keeps its UTMs, even with an older click id on it', function () {
  var v = visitor();
  var url = 'https://shop.example.com/?utm_source=google&utm_medium=cpc&utm_campaign=brand_search&gclid=Cj0_google_click&fbclid=IwAR_meta_click';
  v.load(META_LANDING).pageView();
  v.clock.advance(HOUR);
  v.load(url).pageView();
  v.clock.advance(HOUR);
  var view = v.load(url).pageView();

  assert.strictEqual(view.traffic_source_name, 'google');
  assert.strictEqual(view.utm_campaign, 'brand_search');
});

test('reloading the last click\'s own landing does not restart its 24-hour UTM window', function () {
  var v = visitor();
  v.load(META_LANDING_WITH_UTMS).pageView();
  v.clock.advance(25 * HOUR);
  var view = v.load(META_LANDING_WITH_UTMS).pageView();

  assert.strictEqual(view.traffic_source_name, 'meta');
  assert.strictEqual(view.utm_campaign, '');
  // The campaign is still known, through the Meta click's own params.
  assert.match(view.meta_click_params, /utm_campaign=spring/);
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

test('a restored tab of the first of two clicks from one network does not outrank a later click', function () {
  var v = visitor();
  v.load('https://shop.example.com/?utm_campaign=brand_a&gad_campaignid=111&gclid=Cj0_google_A').pageView();
  v.clock.advance(DAY);
  v.load('https://shop.example.com/?utm_campaign=brand_b&gad_campaignid=222&gclid=Cj0_google_B').pageView();
  v.clock.advance(DAY);
  v.load(META_LANDING).pageView();
  v.clock.advance(HOUR);
  var view = v.load('https://shop.example.com/?utm_campaign=brand_a&gad_campaignid=111&gclid=Cj0_google_A').pageView();

  assert.strictEqual(view.traffic_source_name, 'meta');
  assert.strictEqual(view.gclid, 'Cj0_google_B');
  assert.strictEqual(view.gad_campaignid, '');
  assert.strictEqual(view.utm_campaign, '');
});

test('a restored tab of an earlier click from the same network keeps the later click\'s campaign', function () {
  var v = visitor();
  v.load('https://shop.example.com/?utm_campaign=brand_a&gad_campaignid=111&gclid=Cj0_google_A').pageView();
  v.clock.advance(DAY);
  v.load('https://shop.example.com/?utm_campaign=brand_b&gad_campaignid=222&gclid=Cj0_google_B').pageView();
  v.clock.advance(HOUR);
  var view = v.load('https://shop.example.com/?utm_campaign=brand_a&gad_campaignid=111&gclid=Cj0_google_A').pageView();

  assert.strictEqual(view.gclid, 'Cj0_google_B');
  assert.strictEqual(view.gad_campaignid, '222');
  assert.strictEqual(view.utm_campaign, 'brand_b');
});

test('a click id stored by an earlier SDK version is still recognised once a newer click replaces it', function () {
  var v = visitor({
    storage: function (now) { return { lr_gclid: stored('Cj0_google_A', now - 3 * DAY) }; },
  });
  v.load('https://shop.example.com/?gclid=Cj0_google_B').pageView();
  v.clock.advance(HOUR);
  v.load(META_LANDING).pageView();
  v.clock.advance(HOUR);
  var view = v.load('https://shop.example.com/?gclid=Cj0_google_A').pageView();

  assert.strictEqual(view.traffic_source_name, 'meta');
  assert.strictEqual(view.gclid, 'Cj0_google_B');
});

test('a repeated gbraid is a new Google click, because Google shares it across clicks', function () {
  var v = visitor();
  v.load('https://shop.example.com/?gad_campaignid=111&gbraid=0AAAA_shared').pageView();
  v.clock.advance(DAY);
  v.load(META_LANDING).pageView();
  v.clock.advance(DAY);
  var view = v.load('https://shop.example.com/?gad_campaignid=333&gbraid=0AAAA_shared').pageView();

  assert.strictEqual(view.traffic_source_name, 'google');
  assert.strictEqual(view.gad_campaignid, '333');
});

test('reloading a gbraid landing is not a new Google click', function () {
  var v = visitor();
  var url = 'https://shop.example.com/?gad_campaignid=111&gbraid=0AAAA_shared';
  v.load(url).pageView();
  v.clock.advance(DAY);
  v.load(META_LANDING).pageView();
  v.clock.advance(HOUR);
  ['reload', 'back_forward'].forEach(function (navigationType) {
    var view = loadSdk({ url: url, clock: v.clock, localStorage: v.localStorage, sessionStorage: createStorage(), navigationType: navigationType }).pageView();
    assert.strictEqual(view.traffic_source_name, 'meta', navigationType);
    assert.strictEqual(view.gad_campaignid, '', navigationType);
  });
});

test('a call queued before the script loaded belongs to this landing\'s click', function () {
  var v = visitor();
  v.load(GOOGLE_LANDING).pageView();
  v.clock.advance(DAY);
  var sdk = loadSdk({ url: META_LANDING, clock: v.clock, localStorage: v.localStorage, sessionStorage: createStorage(), queue: [['lead', { form: 'callback' }]] });
  var lead = sdk.sent[0];

  assert.strictEqual(lead.event_name, 'lead');
  assert.strictEqual(lead.traffic_source_name, 'meta');
  assert.strictEqual(lead.fbclid, 'IwAR_meta_click');
  assert.strictEqual(lead.gad_campaignid, '');
});

test('a first visit\'s queued call takes its first touch from the landing', function () {
  var sdk = loadSdk({ url: GOOGLE_LANDING, clock: createClock(), localStorage: createStorage(), sessionStorage: createStorage(), queue: [['lead', {}]] });

  assert.strictEqual(sdk.sent[0].traffic_source_name, 'google');
  assert.strictEqual(sdk.sent[0].ft_traffic_source_name, 'google');
});

test('fbc carries the Meta click\'s own time, and a reload does not re-date it', function () {
  var v = visitor();
  var clickTime = v.clock.now;
  var first = v.load(META_LANDING);
  var landing = first.pageView();
  assert.strictEqual(landing.fbc, 'fb.1.' + clickTime + '.IwAR_meta_click');

  v.clock.advance(2 * DAY);
  var reload = loadSdk({ url: META_LANDING, clock: v.clock, localStorage: v.localStorage, sessionStorage: createStorage(), cookie: first.sandbox.document.cookie });
  var view = reload.pageView();

  assert.strictEqual(view.fbc, 'fb.1.' + clickTime + '.IwAR_meta_click');
  assert.match(reload.sandbox.document.cookie, new RegExp('_fbc=fb\\.1\\.' + clickTime + '\\.IwAR_meta_click'));
});

test('a new fbclid is sent with its own fbc, not the previous Meta click\'s cookie', function () {
  var v = visitor({ cookie: '_fbc=fb.1.1700000000000.IwAR_old_click' });
  var view = v.load('https://shop.example.com/?fbclid=IwAR_new_click').pageView();

  assert.strictEqual(view.fbc, 'fb.1.' + v.clock.now + '.IwAR_new_click');
});

test('fbp or fbc passed on a URL is not an ad click and keeps the last click\'s UTMs', function () {
  var v = visitor();
  v.load(META_LANDING_WITH_UTMS).pageView();
  ['?fbp=fb.1.123.456', '?fbc=fb.1.123.IwAR_hop'].forEach(function (query) {
    v.clock.advance(10 * MINUTE);
    var view = v.load('https://shop.example.com/checkout' + query).pageView();
    assert.strictEqual(view.traffic_source_name, 'meta', query);
    assert.strictEqual(view.utm_campaign, 'spring', query);
  });
});

test('a stored click id without a usable time still decides the source', function () {
  var v = visitor({ storage: function () { return { lr_gclid: JSON.stringify({ v: 'Cj0_google_click' }) }; } });
  var view = v.load(PLAIN_PAGE).pageView();

  assert.strictEqual(view.traffic_source_name, 'google');
});

test('a gbraid next to a known gclid follows the gclid, even on a plain navigation', function () {
  var v = visitor();
  var url = 'https://shop.example.com/?utm_campaign=g&gad_campaignid=111&gbraid=0AAAA_shared&gclid=Cj0_google_click';
  v.load(url).pageView();
  v.clock.advance(DAY);
  v.load(META_LANDING).pageView();
  v.clock.advance(HOUR);
  var view = v.load(url).pageView();

  assert.strictEqual(view.traffic_source_name, 'meta');
  assert.strictEqual(view.gad_campaignid, '');
  assert.strictEqual(view.utm_campaign, '');
});

test('a known gbraid carried on the site\'s own links is not a new Google click', function () {
  var v = visitor();
  v.load('https://shop.example.com/?gad_campaignid=111&gbraid=0AAAA_shared').pageView();
  v.clock.advance(DAY);
  v.load(META_LANDING).pageView();
  v.clock.advance(HOUR);
  var view = v.load('https://shop.example.com/products?gbraid=0AAAA_shared', 'https://shop.example.com/').pageView();

  assert.strictEqual(view.traffic_source_name, 'meta');
});

test('a gbraid reload is recognised where only performance.navigation exists', function () {
  var v = visitor();
  var url = 'https://shop.example.com/?gad_campaignid=111&gbraid=0AAAA_shared';
  v.load(url).pageView();
  v.clock.advance(DAY);
  v.load(META_LANDING).pageView();
  v.clock.advance(HOUR);
  var view = loadSdk({ url: url, clock: v.clock, localStorage: v.localStorage, sessionStorage: createStorage(), legacyNavigationType: 1 }).pageView();

  assert.strictEqual(view.traffic_source_name, 'meta');
});

test('without its cookie, fbc is rebuilt with the Meta click\'s own time', function () {
  var v = visitor();
  var clickTime = v.clock.now;
  v.load(META_LANDING).pageView();
  // Safari drops script-set cookies after 7 days; the fbclid itself lasts 90.
  v.clock.advance(10 * DAY);
  var reload = v.load(META_LANDING);
  var view = reload.pageView();

  assert.strictEqual(view.fbc, 'fb.1.' + clickTime + '.IwAR_meta_click');
  // The cookie is put back for the Meta pixel, which reads _fbc itself.
  assert.match(reload.sandbox.document.cookie, new RegExp('_fbc=fb\\.1\\.' + clickTime + '\\.IwAR_meta_click'));
});

test('a malformed record of earlier click ids does not stop the SDK', function () {
  var v = visitor({ storage: function (now) { return { lr_gclid: stored('Cj0_google_A', now - DAY), lr_seen: JSON.stringify({ gclid: 'x' }) }; } });
  var view = v.load('https://shop.example.com/?gclid=Cj0_google_B').pageView();

  assert.strictEqual(view.traffic_source_name, 'google');
  assert.strictEqual(view.gclid, 'Cj0_google_B');
});

test('a payment gateway returning to a gbraid landing is not a new Google click', function () {
  var v = visitor();
  var url = 'https://shop.example.com/?utm_campaign=g&gad_campaignid=111&gbraid=0AAAA_shared';
  v.load(url, 'https://www.google.com/').pageView();
  v.clock.advance(DAY);
  v.load(META_LANDING).pageView();
  v.clock.advance(HOUR);
  var view = v.load(url, 'https://payments.juspay.in/txns/redirect').track('purchase', { amount: 1200 });

  assert.strictEqual(view.traffic_source_name, 'meta');
  assert.strictEqual(view.gad_campaignid, '');
});

test('a repeated wbraid is a new Google click too, from any referrer but the site\'s own', function () {
  var v = visitor();
  var url = 'https://shop.example.com/?gad_campaignid=111&wbraid=0BBBB_shared';
  v.load(url, 'https://www.somepublisher.com/').pageView();
  v.clock.advance(DAY);
  v.load(META_LANDING).pageView();
  v.clock.advance(DAY);
  var view = v.load(url, 'https://www.somepublisher.com/').pageView();

  assert.strictEqual(view.traffic_source_name, 'google');
  assert.strictEqual(view.gad_campaignid, '111');
});

test('earlier click ids stored as an array are replaced by a usable record', function () {
  var v = visitor({ storage: function (now) { return { lr_gclid: stored('Cj0_google_A', now - DAY), lr_seen: '["broken"]' }; } });
  v.load('https://shop.example.com/?gclid=Cj0_google_B').pageView();
  v.clock.advance(HOUR);
  v.load(META_LANDING).pageView();
  v.clock.advance(HOUR);
  var view = v.load('https://shop.example.com/?gclid=Cj0_google_A').pageView();

  assert.strictEqual(view.traffic_source_name, 'meta');
});

test('a stored fbclid without a usable time still gets a well-formed fbc', function () {
  var v = visitor({ storage: function () { return { lr_fbclid: JSON.stringify({ v: 'IwAR_meta_click' }) }; } });
  var view = v.load(META_LANDING).pageView();

  assert.match(view.fbc, /^fb\.1\.\d+\.IwAR_meta_click$/);
});

test('the Meta click\'s campaign, ad set and ad travel with it after its UTMs expire', function () {
  var v = visitor();
  v.load(GOOGLE_LANDING).pageView();
  v.clock.advance(DAY);
  v.load('https://shop.example.com/?utm_source=facebook&utm_medium=paid_social&utm_campaign=diwali&utm_id=120210000000001&utm_term=adset_a&utm_content=ad_a&campaign_id=120210000000001&adset_id=120210000000002&ad_id=120210000000003&fbclid=IwAR_meta_click').pageView();
  v.clock.advance(2 * DAY);
  var purchase = v.load(RETURN_URL, GATEWAY_REFERRER).track('purchase', { amount: 1200 });

  assert.strictEqual(purchase.traffic_source_name, 'meta');
  assert.strictEqual(purchase.utm_campaign, '');
  assert.strictEqual(purchase.meta_click_params,
    'utm_id=120210000000001&campaign_id=120210000000001&adset_id=120210000000002&ad_id=120210000000003' +
    '&utm_source=facebook&utm_medium=paid_social&utm_campaign=diwali&utm_term=adset_a&utm_content=ad_a');
  assert.strictEqual(purchase.ft_meta_click_params, undefined);
  var ctx = JSON.parse(v.localStorage.getItem('lr_ctx'));
  assert.strictEqual(ctx.fields.meta_click_params, purchase.meta_click_params);
});

test('a new Meta click without params does not inherit the previous Meta click\'s', function () {
  var v = visitor();
  v.load(META_LANDING_WITH_UTMS).pageView();
  v.clock.advance(DAY);
  var view = v.load('https://shop.example.com/?fbclid=IwAR_second_meta_click').pageView();

  assert.strictEqual(view.meta_click_params, '');
});

test('the Meta click\'s params are sent only while it is the last click', function () {
  var v = visitor();
  v.load(META_LANDING_WITH_UTMS).pageView();
  v.clock.advance(DAY);
  var view = v.load(GOOGLE_LANDING).pageView();

  assert.strictEqual(view.traffic_source_name, 'google');
  assert.strictEqual(view.meta_click_params, '');
});

test('the Meta click\'s params expire with it, after 90 days', function () {
  var v = visitor();
  v.load(META_LANDING_WITH_UTMS).pageView();
  v.clock.advance(91 * DAY);
  var view = v.load(PLAIN_PAGE).pageView();

  assert.strictEqual(view.fbclid, '');
  assert.strictEqual(view.meta_click_params, '');
  assert.strictEqual(v.localStorage.getItem('lr_meta_click_params'), null);
});

test('a device clock corrected between two clicks does not decide which is last', function () {
  var v = visitor();
  // The Google click is stored while the clock runs a day fast.
  v.clock.advance(DAY);
  v.load(GOOGLE_LANDING).pageView();
  v.clock.advance(-DAY + HOUR);
  var view = v.load(META_LANDING).pageView();

  assert.strictEqual(view.traffic_source_name, 'meta');
  assert.strictEqual(view.gad_campaignid, '');
});

test('a numbered click outranks clicks stored before numbers existed', function () {
  var v = visitor({ storage: function (now) { return { lr_fbclid: stored('IwAR_legacy_click', now - DAY) }; } });
  var view = v.load(GOOGLE_LANDING).pageView();

  assert.strictEqual(view.traffic_source_name, 'google');
});

test('after a rollback, a click the earlier SDK stored later still wins', function () {
  var v = visitor();
  v.load(META_LANDING_WITH_UTMS).pageView();
  v.clock.advance(HOUR);
  v.load(GOOGLE_LANDING).pageView();
  // Rolled back for a day: the earlier SDK stores a newer Meta click with no number and
  // leaves the stored Meta params as they were.
  v.clock.advance(DAY);
  v.localStorage.setItem('lr_fbclid', stored('IwAR_rollback_click', v.clock.now));
  v.clock.advance(HOUR);
  var view = v.load(PLAIN_PAGE).pageView();

  assert.strictEqual(view.traffic_source_name, 'meta');
  assert.strictEqual(view.fbclid, 'IwAR_rollback_click');
  // The stored params belong to the first Meta click, so they are not sent with this one.
  assert.strictEqual(view.meta_click_params, '');
});

test('a page left before its page view was due still sends it', function () {
  var v = visitor();
  var sdk = loadSdk({ url: META_LANDING, clock: v.clock, localStorage: v.localStorage, sessionStorage: createStorage() });
  assert.strictEqual(sdk.sent.length, 0);
  sdk.dispatch('pagehide');

  assert.strictEqual(sdk.sent.length, 1);
  assert.strictEqual(sdk.sent[0].event_type, 'page_view');
  // The deferred one that follows is the same page view, not a second.
  sdk.flush();
  assert.strictEqual(sdk.sent.length, 1);
});

test('the Shopify context record says when the last-touch UTMs were recorded', function () {
  var v = visitor();
  var clickTime = v.clock.now;
  v.load(META_LANDING_WITH_UTMS).pageView();
  v.clock.advance(23 * HOUR);
  v.load(PLAIN_PAGE).pageView();

  var ctx = JSON.parse(v.localStorage.getItem('lr_ctx'));
  assert.strictEqual(ctx.t, clickTime + 23 * HOUR);
  assert.strictEqual(ctx.utm_t, clickTime);
});

test('a lost click counter does not reuse a number a stored click already has', function () {
  var v = visitor();
  v.load(GOOGLE_LANDING).pageView();
  v.clock.advance(HOUR);
  v.load(META_LANDING).pageView();
  v.localStorage.removeItem('lr_click_seq');
  v.clock.advance(HOUR);
  var view = v.load(SECOND_GOOGLE_LANDING).pageView();

  assert.strictEqual(view.traffic_source_name, 'google');
  assert.strictEqual(view.gad_campaignid, '222');
});

test('a restored tab of an earlier Meta landing keeps the later Meta click\'s params', function () {
  var v = visitor();
  v.load('https://shop.example.com/?utm_campaign=first_campaign&fbclid=IwAR_first').pageView();
  v.clock.advance(DAY);
  v.load('https://shop.example.com/?utm_campaign=second_campaign&fbclid=IwAR_second').pageView();
  v.clock.advance(HOUR);
  var view = v.load('https://shop.example.com/?utm_campaign=first_campaign&fbclid=IwAR_first').pageView();

  assert.strictEqual(view.fbclid, 'IwAR_second');
  assert.strictEqual(view.meta_click_params, 'utm_campaign=second_campaign');
});

test('the Meta params keep separators and non-Latin names intact, and drop whole params past the cap', function () {
  var v = visitor();
  var name = 'दिवाली घी & मिठाई = ऑफ़र';
  var long = new Array(300).join('घ');
  var view = v.load('https://shop.example.com/?utm_id=120210000000001&campaign_id=120210000000002&utm_campaign=' +
    encodeURIComponent(name) + '&utm_term=' + encodeURIComponent(long) + '&fbclid=IwAR_meta_click').pageView();

  var parsed = new URLSearchParams(view.meta_click_params);
  assert.strictEqual(parsed.get('utm_id'), '120210000000001');
  assert.strictEqual(parsed.get('campaign_id'), '120210000000002');
  assert.strictEqual(parsed.get('utm_campaign'), name);
  assert.strictEqual(parsed.get('utm_term'), null);
  assert.ok(view.meta_click_params.length <= 2000);
});

test('pagehide after the page view went out sends nothing more, even after a hash change', function () {
  var sdk = loadSdk({ url: META_LANDING, clock: createClock(), localStorage: createStorage(), sessionStorage: createStorage() });
  sdk.pageView();
  sdk.sandbox.location.href = META_LANDING + '#reviews';
  sdk.dispatch('pagehide');

  assert.strictEqual(sdk.sent.length, 1);
});

test('a page view sent before the load finished reports no load timings', function () {
  var sdk = loadSdk({ url: META_LANDING, clock: createClock(), localStorage: createStorage(), sessionStorage: createStorage(), navigationType: 'navigate' });
  sdk.dispatch('pagehide');

  assert.strictEqual(sdk.sent[0].page_load_time, undefined);
});
