'use strict';

// LIN-4884 — a web-to-app flow lands the ad click on the customer's site and sends the
// visitor to the store from a CTA a few pages later. getAppDownloadURL() hands that CTA
// the project's Linkrunner link with the last touch's ad click params, so the install is
// credited to the ad without the customer carrying the params through their pages.

var test = require('node:test');
var assert = require('node:assert');

var harness = require('./helpers/sdk-harness');
var loadSdk = harness.loadSdk;
var createClock = harness.createClock;
var createStorage = harness.createStorage;
var MINUTE = harness.MINUTE;
var HOUR = harness.HOUR;

var BASE = 'https://link.credfix.app/';

var META_LANDING =
  'https://credfix.app/start?utm_source=facebook&utm_medium=paid_social' +
  '&campaign_id=120210001&adset_id=120210002&ad_id=120210003' +
  '&placement=Instagram_Stories&site_source=ig&fbclid=IwAR_meta_click';
var GOOGLE_LANDING =
  'https://credfix.app/start?utm_source=google&utm_campaign=Loans-Search' +
  '&gad_source=1&gad_campaignid=22329341502&gclid=Cj0_google_click';
var ONBOARDING_STEP = 'https://credfix.app/onboarding/step-3';

// One page load per call, sharing localStorage like one visitor in fresh tabs.
function visitor() {
  var clock = createClock();
  var localStorage = createStorage();
  return {
    clock: clock,
    localStorage: localStorage,
    load: function (url, extra) {
      var options = { url: url, clock: clock, localStorage: localStorage, sessionStorage: createStorage() };
      Object.assign(options, extra || {});
      return loadSdk(options);
    },
  };
}

function appUrl(sdk, base) {
  return sdk.sandbox.window.lr.getAppDownloadURL(base === undefined ? BASE : base);
}

function query(href) {
  return Array.from(new URL(href).searchParams.entries());
}

test('a Meta click becomes the Meta web-to-app link on a later page', async function () {
  var v = visitor();
  v.load(META_LANDING).pageView();
  v.clock.advance(4 * MINUTE);

  var href = await appUrl(v.load(ONBOARDING_STEP));

  assert.strictEqual(
    href,
    'https://link.credfix.app/?utm_source=facebook&utm_medium=paid_social&campaign_id=120210001' +
      '&adset_id=120210002&ad_id=120210003&placement=Instagram_Stories&site_source=ig&fbclid=IwAR_meta_click'
  );
});

test("Meta's default template fills campaign_id from utm_id and adset_id from ad_set_id", async function () {
  var v = visitor();
  v.load('https://credfix.app/start?utm_source=fb&utm_id=120219999&ad_set_id=120218888&fbclid=IwAR_default');

  var href = await appUrl(v.load(ONBOARDING_STEP));

  assert.deepStrictEqual(query(href), [
    ['utm_source', 'facebook'],
    ['utm_medium', 'paid_social'],
    ['campaign_id', '120219999'],
    ['adset_id', '120218888'],
    ['fbclid', 'IwAR_default'],
  ]);
});

test('a Google click becomes the Google web-to-app link on a later page', async function () {
  var v = visitor();
  v.load(GOOGLE_LANDING).pageView();
  v.clock.advance(4 * MINUTE);

  var href = await appUrl(v.load(ONBOARDING_STEP));

  assert.strictEqual(
    href,
    'https://link.credfix.app/?gad_campaignid=22329341502&gad_source=1&gclid=Cj0_google_click' +
      '&utm_source=google&utm_campaign=Loans-Search'
  );
});

test('params the click did not carry are left out', async function () {
  var v = visitor();
  v.load('https://credfix.app/start?wbraid=WB_ios_click');

  var href = await appUrl(v.load(ONBOARDING_STEP));

  assert.deepStrictEqual(query(href), [['wbraid', 'WB_ios_click'], ['utm_source', 'google']]);
});

test('a new Google click without gad_source clears the previous one', async function () {
  var v = visitor();
  v.load(GOOGLE_LANDING);
  v.clock.advance(MINUTE);
  v.load('https://credfix.app/start?gad_campaignid=24137000536&gclid=Cj0_second_click');

  var href = await appUrl(v.load(ONBOARDING_STEP));

  assert.deepStrictEqual(query(href), [
    ['gad_campaignid', '24137000536'],
    ['gclid', 'Cj0_second_click'],
    ['utm_source', 'google'],
  ]);
});

test('the last ad click decides the network', async function () {
  var v = visitor();
  v.load(GOOGLE_LANDING);
  v.clock.advance(HOUR);
  v.load(META_LANDING);
  assert.match(await appUrl(v.load(ONBOARDING_STEP)), /fbclid=IwAR_meta_click/);

  v.clock.advance(HOUR);
  v.load('https://credfix.app/start?gad_campaignid=24137000536&gclid=Cj0_later_google');
  var href = await appUrl(v.load(ONBOARDING_STEP));
  assert.match(href, /gclid=Cj0_later_google/);
  assert.doesNotMatch(href, /fbclid/);
});

test('a later tagged visit with no ad click takes last touch with its UTMs', async function () {
  var v = visitor();
  v.load(META_LANDING);
  v.clock.advance(HOUR);
  v.load('https://credfix.app/start?utm_source=newsletter&utm_medium=email&utm_campaign=nov', {
    referrer: 'https://mail.google.com/',
  });

  var href = await appUrl(v.load(ONBOARDING_STEP));

  assert.deepStrictEqual(query(href), [
    ['utm_source', 'newsletter'],
    ['utm_medium', 'email'],
    ['utm_campaign', 'nov'],
  ]);
});

test('a visitor with no ad click or UTMs gets the base URL unchanged', async function () {
  var v = visitor();
  assert.strictEqual(await appUrl(v.load('https://credfix.app/')), BASE);
});

test("the base URL's own path and params are kept", async function () {
  var v = visitor();
  v.load(GOOGLE_LANDING);

  var href = await appUrl(v.load(ONBOARDING_STEP), 'https://link.credfix.app/install?ref=cta');

  assert.strictEqual(new URL(href).pathname, '/install');
  assert.deepStrictEqual(query(href).slice(0, 2), [['ref', 'cta'], ['gad_campaignid', '22329341502']]);
});

test('a base URL that is not an absolute http(s) URL is rejected', async function () {
  var sdk = visitor().load(GOOGLE_LANDING);
  await assert.rejects(appUrl(sdk, '/download'), /absolute http\(s\) URL/);
  await assert.rejects(appUrl(sdk, 'javascript:alert(1)'), /absolute http\(s\) URL/);
  await assert.rejects(appUrl(sdk, ''), /absolute http\(s\) URL/);
});

test('a call queued before the script loaded resolves with the landing click', async function () {
  var resolved = new Promise(function (resolve, reject) {
    loadSdk({ url: META_LANDING, queue: [['__getAppDownloadURL', BASE, resolve, reject]] });
  });

  assert.match(await resolved, /^https:\/\/link\.credfix\.app\/\?utm_source=facebook&.*fbclid=IwAR_meta_click$/);
});

test('placement and site_source ride with the Meta click params; gad_source is not sent', function () {
  var v = visitor();
  var metaView = v.load(META_LANDING).pageView();
  assert.match(metaView.meta_click_params, /placement=Instagram_Stories&site_source=ig/);

  var googleView = v.load(GOOGLE_LANDING).pageView();
  assert.strictEqual(googleView.gad_source, undefined);
});
