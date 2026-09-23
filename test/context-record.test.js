'use strict';

// lr_ctx is the one storage record the Shopify checkout pixel reads (docs:
// sdk/shopify.mdx). These tests pin its shape, because the pixel is pasted into
// merchants' stores and cannot be updated with a release.

var test = require('node:test');
var assert = require('node:assert');

var harness = require('./helpers/sdk-harness');
var loadSdk = harness.loadSdk;
var createClock = harness.createClock;
var createStorage = harness.createStorage;
var MINUTE = harness.MINUTE;

var CAMPAIGN_URL =
  'https://shop.example.com/?utm_source=meta&utm_medium=paid_social&utm_campaign=spring_sale&fbclid=IwAR_click';

function readContext(sdk) {
  return JSON.parse(sdk.localStorage.getItem('lr_ctx'));
}

test('a page view writes the context record with identity, campaign, and endpoint', function () {
  var clock = createClock();
  var sdk = loadSdk({ url: CAMPAIGN_URL, clock: clock });
  var view = sdk.pageView();
  var ctx = readContext(sdk);

  assert.strictEqual(ctx.v, 1);
  assert.strictEqual(ctx.t, clock.now);
  assert.strictEqual(ctx.endpoint, 'https://api.linkrunner.io/web/ingest');
  assert.strictEqual(ctx.fields.visitor_id, view.visitor_id);
  assert.strictEqual(ctx.fields.session_id, view.session_id);
  assert.strictEqual(ctx.fields.utm_campaign, 'spring_sale');
  assert.strictEqual(ctx.fields.ft_utm_campaign, 'spring_sale');
  assert.strictEqual(ctx.fields.fbclid, 'IwAR_click');
  assert.strictEqual(ctx.fields.ft_fbclid, 'IwAR_click');
  assert.strictEqual(ctx.fields.traffic_source_type, view.traffic_source_type);
  assert.strictEqual(ctx.fields.ft_traffic_source_type, view.ft_traffic_source_type);
});

test('the record carries every attribution field the event itself sends', function () {
  var sdk = loadSdk({ url: CAMPAIGN_URL });
  var view = sdk.pageView();
  var fields = readContext(sdk).fields;

  Object.keys(view)
    .filter(function (k) { return /^(ft_)?(utm_|traffic_source_)/.test(k) || k in fields; })
    .forEach(function (k) { assert.strictEqual(fields[k], view[k], k); });
  ['gclid', 'fbclid', 'ttclid', 'msclkid'].forEach(function (k) {
    assert.ok(k in fields, k);
    assert.ok('ft_' + k in fields, 'ft_' + k);
  });
});

test('the record leaves out per-event and per-page fields', function () {
  var sdk = loadSdk({ url: CAMPAIGN_URL });
  sdk.pageView();
  var fields = readContext(sdk).fields;

  ['token', 'event_id', 'event_type', 'event_name', 'event_data', 'page_url', 'client_timestamp'].forEach(function (k) {
    assert.ok(!(k in fields), k);
  });
});

test('identify puts the user ID into the record', function () {
  var sdk = loadSdk({ url: CAMPAIGN_URL });
  sdk.pageView();
  assert.strictEqual(readContext(sdk).fields.user_id, '');

  sdk.sandbox.window.lr.identify('9427286032605');
  assert.strictEqual(readContext(sdk).fields.user_id, '9427286032605');
});

test('data-domain is carried as the full ingest URL', function () {
  var sdk = loadSdk({
    url: CAMPAIGN_URL,
    config: {},
    scriptAttrs: { 'data-token': 'test_token', 'data-domain': 'lr.shop.example.com' },
  });
  sdk.pageView();
  assert.strictEqual(readContext(sdk).endpoint, 'https://lr.shop.example.com/web/ingest');
});

test('a relative data-endpoint is made absolute, because the pixel runs on another origin', function () {
  var sdk = loadSdk({
    url: CAMPAIGN_URL,
    config: {},
    scriptAttrs: { 'data-token': 'test_token', 'data-endpoint': '/lr/ingest' },
  });
  sdk.pageView();
  assert.strictEqual(readContext(sdk).endpoint, 'https://shop.example.com/lr/ingest');
});

test('each event refreshes the record, so a later campaign replaces an earlier one', function () {
  var clock = createClock();
  var localStorage = createStorage();
  loadSdk({ url: CAMPAIGN_URL, clock: clock, localStorage: localStorage }).pageView();

  clock.advance(30 * MINUTE);
  var second = loadSdk({
    url: 'https://shop.example.com/?utm_source=google&utm_medium=cpc&utm_campaign=brand',
    clock: clock,
    localStorage: localStorage,
    sessionStorage: createStorage(),
  });
  second.pageView();
  var ctx = readContext(second);

  assert.strictEqual(ctx.t, clock.now);
  assert.strictEqual(ctx.fields.utm_campaign, 'brand');
  assert.strictEqual(ctx.fields.ft_utm_campaign, 'spring_sale');
});
