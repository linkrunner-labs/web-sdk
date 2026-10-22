'use strict';

// LIN-3904: an affiliate's web link carries the utm_id the partner is credited by and ends
// lr_click_id=<the partner's click macro>, and the partner's postback for a purchase needs
// that click id back. The purchase usually fires on a later page, so the SDK persists it,
// but only together with the utm_id it arrived with: partner A's click id must never ride
// along with partner B's (or Meta's) utm_id.

var test = require('node:test');
var assert = require('node:assert');

var harness = require('./helpers/sdk-harness');
var loadSdk = harness.loadSdk;
var createClock = harness.createClock;
var createStorage = harness.createStorage;
var MINUTE = harness.MINUTE;
var HOUR = harness.HOUR;

var PARTNER_A_UTMS =
  'utm_source=partner_a&utm_medium=affiliate&utm_campaign=diwali&utm_id=wc_partner_a';
var PARTNER_A_LANDING = 'https://shop.example.com/sale?' + PARTNER_A_UTMS + '&lr_click_id=pa_click_111';
var PARTNER_B_LANDING =
  'https://shop.example.com/sale?utm_source=partner_b&utm_medium=affiliate&utm_campaign=diwali' +
  '&utm_id=wc_partner_b&lr_click_id=pb_click_222';
var META_LANDING =
  'https://shop.example.com/sale?utm_source=meta&utm_medium=paid_social&utm_campaign=retarget' +
  '&utm_id=120210987654321';
var GATEWAY_RETURN_URL = 'https://shop.example.com/confirmation?status=CHARGED&order_id=OD9241';
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

test('the affiliate click id reaches a purchase on the gateway return page', function () {
  var v = visitor();
  var landing = v.load(PARTNER_A_LANDING).pageView();
  assert.strictEqual(landing.lr_click_id, 'pa_click_111');

  v.clock.advance(9 * MINUTE);
  var purchase = v.load(GATEWAY_RETURN_URL, GATEWAY_REFERRER).track('purchase', { amount: 1200 });

  assert.strictEqual(purchase.utm_id, 'wc_partner_a');
  assert.strictEqual(purchase.lr_click_id, 'pa_click_111');
  assert.strictEqual(purchase.ft_lr_click_id, 'pa_click_111');
});

test('a new affiliate click replaces the click id, and first touch keeps the first', function () {
  var v = visitor();
  v.load(PARTNER_A_LANDING).pageView();
  v.clock.advance(MINUTE);
  var view = v.load(PARTNER_B_LANDING).pageView();

  assert.strictEqual(view.utm_id, 'wc_partner_b');
  assert.strictEqual(view.lr_click_id, 'pb_click_222');
  assert.strictEqual(view.ft_utm_id, 'wc_partner_a');
  assert.strictEqual(view.ft_lr_click_id, 'pa_click_111');
});

test('a second click on the same affiliate link replaces the click id', function () {
  var v = visitor();
  v.load(PARTNER_A_LANDING).pageView();
  v.clock.advance(MINUTE);
  var view = v.load('https://shop.example.com/sale?' + PARTNER_A_UTMS + '&lr_click_id=pa_click_999').pageView();

  assert.strictEqual(view.lr_click_id, 'pa_click_999');
  assert.strictEqual(view.ft_lr_click_id, 'pa_click_111');
});

test('internal links that repeat the landing\'s UTMs keep the click id', function () {
  var v = visitor();
  v.load(PARTNER_A_LANDING).pageView();
  v.clock.advance(MINUTE);
  // Some sites copy the landing's utm_* onto every internal link, but not lr_click_id.
  v.load('https://shop.example.com/product/42?' + PARTNER_A_UTMS, 'https://shop.example.com/sale').pageView();
  v.clock.advance(MINUTE);
  var purchase = v.load(GATEWAY_RETURN_URL, GATEWAY_REFERRER).track('purchase', { amount: 1200 });

  assert.strictEqual(purchase.utm_id, 'wc_partner_a');
  assert.strictEqual(purchase.lr_click_id, 'pa_click_111');
});

test('past the 24-hour last-touch window, only the same utm_id keeps the click id', function () {
  [
    { url: 'https://shop.example.com/product/42?' + PARTNER_A_UTMS, want: 'pa_click_111' },
    { url: META_LANDING, want: '' },
    { url: 'https://shop.example.com/sale?utm_source=newsletter&utm_medium=email', want: '' },
  ].forEach(function (c) {
    var v = visitor();
    v.load(PARTNER_A_LANDING).pageView();
    // The last-touch UTMs have expired; the click id has not, and still knows its utm_id.
    v.clock.advance(25 * HOUR);
    var view = v.load(c.url).pageView();

    assert.strictEqual(view.lr_click_id, c.want, c.url);
  });
});

test('a later non-affiliate campaign landing clears the click id', function () {
  var v = visitor();
  v.load(PARTNER_A_LANDING).pageView();
  v.clock.advance(MINUTE);
  v.load(META_LANDING).pageView();
  v.clock.advance(MINUTE);
  var purchase = v.load(GATEWAY_RETURN_URL, GATEWAY_REFERRER).track('purchase', { amount: 1200 });

  // Partner A's click id must not pair with Meta's utm_id.
  assert.strictEqual(purchase.utm_id, '120210987654321');
  assert.strictEqual(purchase.lr_click_id, '');
  assert.strictEqual(purchase.ft_lr_click_id, 'pa_click_111');
});

test('UTMs with no utm_id, or a new click id with no UTMs, clear the click id', function () {
  [
    'https://shop.example.com/sale?utm_source=newsletter&utm_medium=email',
    'https://shop.example.com/sale?gclid=Cj0_google_click',
  ].forEach(function (url) {
    var v = visitor();
    v.load(PARTNER_A_LANDING).pageView();
    v.clock.advance(MINUTE);
    var view = v.load(url).pageView();

    assert.strictEqual(view.utm_id, '', url);
    assert.strictEqual(view.lr_click_id, '', url);
  });
});

test('an lr_click_id without a utm_id is ignored', function () {
  var v = visitor();
  var bare = v.load('https://shop.example.com/sale?lr_click_id=pc_click_333').pageView();
  assert.strictEqual(bare.lr_click_id, '');
  assert.strictEqual(bare.ft_lr_click_id, '');

  v = visitor();
  v.load(PARTNER_A_LANDING).pageView();
  v.clock.advance(MINUTE);
  // Not stored, and not a new click: partner A's campaign stays whole, in every tab.
  var view = v.load('https://shop.example.com/sale?lr_click_id=pb_click_222').pageView();
  assert.strictEqual(view.utm_id, 'wc_partner_a');
  assert.strictEqual(view.lr_click_id, 'pa_click_111');

  v.clock.advance(MINUTE);
  var purchase = v.load(GATEWAY_RETURN_URL, GATEWAY_REFERRER).track('purchase', { amount: 1200 });
  assert.strictEqual(purchase.utm_id, 'wc_partner_a');
  assert.strictEqual(purchase.lr_click_id, 'pa_click_111');
});

test('an unexpanded click macro is not stored, and clears the previous partner\'s click id', function () {
  [
    '{click_id}',
    '%7Bclick_id%7D', // decodes to {click_id}
    '%257Bclick_id%257D', // encoded twice, decodes to %7Bclick_id%7D
  ].forEach(function (macro) {
    var v = visitor();
    var fresh = v.load(
      'https://shop.example.com/sale?utm_source=partner_b&utm_id=wc_partner_b&lr_click_id=' + macro,
    ).pageView();
    assert.strictEqual(fresh.lr_click_id, '', macro);
    assert.strictEqual(fresh.ft_lr_click_id, '', macro);

    v.load(PARTNER_A_LANDING).pageView();
    v.clock.advance(MINUTE);
    var view = v.load(
      'https://shop.example.com/sale?utm_source=partner_b&utm_id=wc_partner_b&lr_click_id=' + macro,
    ).pageView();

    assert.strictEqual(view.utm_id, 'wc_partner_b', macro);
    assert.strictEqual(view.lr_click_id, '', macro);
    // First touch is partner B's campaign, so partner A's click id was never first touch.
    assert.strictEqual(view.ft_utm_id, 'wc_partner_b', macro);
    assert.strictEqual(view.ft_lr_click_id, '', macro);
  });
});

test('first touch takes the click id only with the first-touch utm_id', function () {
  var v = visitor();
  v.load(META_LANDING).pageView();
  v.clock.advance(MINUTE);
  var view = v.load(PARTNER_A_LANDING).pageView();

  assert.strictEqual(view.lr_click_id, 'pa_click_111');
  assert.strictEqual(view.ft_utm_id, '120210987654321');
  assert.strictEqual(view.ft_lr_click_id, '');

  // A first touch with no utm_id takes this landing's utm_id and click id together.
  v = visitor();
  v.load('https://shop.example.com/sale?fbclid=IwAR_meta_click').pageView();
  v.clock.advance(MINUTE);
  view = v.load(PARTNER_A_LANDING).pageView();

  assert.strictEqual(view.ft_utm_id, 'wc_partner_a');
  assert.strictEqual(view.ft_lr_click_id, 'pa_click_111');
});

test('a padded click id is trimmed, and a blank one is not stored', function () {
  var v = visitor();
  var view = v.load('https://shop.example.com/sale?' + PARTNER_A_UTMS + '&lr_click_id=%20pa_click_111%20').pageView();
  assert.strictEqual(view.lr_click_id, 'pa_click_111');
  assert.strictEqual(view.ft_lr_click_id, 'pa_click_111');

  v = visitor();
  view = v.load('https://shop.example.com/sale?' + PARTNER_A_UTMS + '&lr_click_id=%20%20').pageView();
  assert.strictEqual(view.lr_click_id, '');
  assert.strictEqual(view.ft_lr_click_id, '');
});

test('a base64 click id keeps its padding', function () {
  [
    { query: PARTNER_A_UTMS + '&lr_click_id=MTIzNDU2Nzg=', want: 'MTIzNDU2Nzg=' },
    { query: 'lr_click_id=MTIzNDU2Nw==&' + PARTNER_A_UTMS, want: 'MTIzNDU2Nw==' },
    { query: PARTNER_A_UTMS + '&lr_click_id=MTIzNDU2Nzg%3D', want: 'MTIzNDU2Nzg=' },
  ].forEach(function (c) {
    var v = visitor();
    var view = v.load('https://shop.example.com/sale?' + c.query).pageView();

    assert.strictEqual(view.lr_click_id, c.want, c.query);
    assert.strictEqual(view.ft_lr_click_id, c.want, c.query);
    assert.strictEqual(view.utm_id, 'wc_partner_a', c.query);
  });
});

test('a malformed click id never stops the page view', function () {
  // A %...% style macro the partner did not expand, or a stray %, is not valid URI encoding.
  // Decoding it must fail quietly: a throw here would abort init and drop the page view.
  ['%click_id%', '50%off'].forEach(function (value) {
    var v = visitor();
    v.load(PARTNER_A_LANDING).pageView();
    v.clock.advance(MINUTE);
    var view = v.load('https://shop.example.com/sale?' + PARTNER_A_UTMS + '&lr_click_id=' + value).pageView();

    assert.strictEqual(view.utm_id, 'wc_partner_a', value);
    // Same campaign, so the click id it arrived with is kept.
    assert.strictEqual(view.lr_click_id, 'pa_click_111', value);
  });
});

test('a repeated lr_click_id reads the last one, like every other param', function () {
  var v = visitor();
  var view = v.load(
    'https://shop.example.com/sale?lr_click_id=pa_click_000&' + PARTNER_A_UTMS + '&lr_click_id=pa_click_111',
  ).pageView();

  assert.strictEqual(view.lr_click_id, 'pa_click_111');
});

test('the click id expires after 90 days, like every click id', function () {
  var v = visitor();
  v.load(PARTNER_A_LANDING).pageView();
  v.clock.advance(91 * 24 * 60 * MINUTE);
  var view = v.load(GATEWAY_RETURN_URL).pageView();

  assert.strictEqual(view.lr_click_id, '');
  assert.strictEqual(view.ft_lr_click_id, 'pa_click_111');
});

test('the click id does not change the traffic source', function () {
  var v = visitor();
  var view = v.load('https://shop.example.com/sale?utm_id=wc_partner_c&lr_click_id=pc_click_333').pageView();

  assert.strictEqual(view.lr_click_id, 'pc_click_333');
  assert.strictEqual(view.traffic_source_type, 'direct');
  assert.strictEqual(view.traffic_source_name, 'direct');
});

test('the Shopify context record carries the click id', function () {
  var v = visitor();
  v.load(PARTNER_A_LANDING).pageView();

  var ctx = JSON.parse(v.localStorage.getItem('lr_ctx'));
  assert.strictEqual(ctx.fields.lr_click_id, 'pa_click_111');
  assert.strictEqual(ctx.fields.ft_lr_click_id, 'pa_click_111');
});
