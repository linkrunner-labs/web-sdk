'use strict';

// Partner placeholder slots (lr_sub1..lr_sub5): an affiliate fills them per click, and
// they must reach the sign-up and purchase on later pages with the campaign touch.

var test = require('node:test');
var assert = require('node:assert');

var harness = require('./helpers/sdk-harness');
var loadSdk = harness.loadSdk;
var createClock = harness.createClock;
var createStorage = harness.createStorage;
var HOUR = harness.HOUR;
var MINUTE = harness.MINUTE;

var SITE = 'https://shop.example.com/';
var SUBS = ['lr_sub1', 'lr_sub2', 'lr_sub3', 'lr_sub4', 'lr_sub5'];

function visitor() {
  return { clock: createClock(), localStorage: createStorage() };
}

// A fresh tab, so nothing carries over except the shared localStorage.
function land(v, url, extra) {
  var options = { url: url, clock: v.clock, localStorage: v.localStorage, sessionStorage: createStorage() };
  Object.keys(extra || {}).forEach(function (k) { options[k] = extra[k]; });
  return loadSdk(options);
}

function subsOf(payload, prefix) {
  return SUBS.map(function (k) { return payload[(prefix || '') + k]; });
}

test('sub slots from the landing reach an event on a later page', function () {
  var v = visitor();
  var view = land(v, SITE + '?utm_source=affiliate&utm_id=web_abc&lr_sub1=pub_42&lr_sub2=email&lr_sub5=x5').pageView();
  assert.deepStrictEqual(subsOf(view), ['pub_42', 'email', '', '', 'x5']);
  assert.deepStrictEqual(subsOf(view, 'ft_'), ['pub_42', 'email', '', '', 'x5']);

  v.clock.advance(20 * MINUTE);
  var signup = land(v, SITE + 'signup?step=2').track('sign_up');
  assert.deepStrictEqual(subsOf(signup), ['pub_42', 'email', '', '', 'x5']);
  assert.deepStrictEqual(subsOf(signup, 'ft_'), ['pub_42', 'email', '', '', 'x5']);
  assert.strictEqual(signup.utm_id, 'web_abc');
});

test('every sub field is sent as a string, empty without a partner link', function () {
  var view = land(visitor(), SITE).pageView();
  SUBS.forEach(function (k) {
    assert.strictEqual(view[k], '', k);
    assert.strictEqual(view['ft_' + k], '', 'ft_' + k);
  });
});

test('lr_subN wins over its aliases, and aliases fill in priority order', function () {
  var both = land(visitor(), SITE + '?utm_id=web_abc&utm_source=aff&lr_sub1=mine&af_siteid=theirs&af_sub1=other').pageView();
  assert.strictEqual(both.lr_sub1, 'mine');

  var aliases = land(visitor(), SITE + '?utm_id=web_abc&utm_source=aff&af_sub1=second&af_siteid=first' +
    '&af_sub_siteid=site2&source=src&af_sub2=s3&af_sub3=s4&af_sub4=s5').pageView();
  assert.deepStrictEqual(subsOf(aliases), ['first', 'site2', 's3', 's4', 's5']);

  var fallback = land(visitor(), SITE + '?utm_id=web_abc&utm_source=aff&af_sub1=second&source=src').pageView();
  assert.deepStrictEqual(subsOf(fallback), ['second', 'src', '', '', '']);
});

test('an lr_subN left as an unfilled placeholder is not replaced by an alias', function () {
  var view = land(visitor(), SITE + '?utm_id=web_abc&utm_source=aff&lr_sub1={publisher_id}&af_siteid=theirs').pageView();
  assert.strictEqual(view.lr_sub1, '');
});

test('source fills sub2 only next to a utm_id', function () {
  var without = land(visitor(), SITE + '?utm_source=newsletter&source=header_banner').pageView();
  assert.strictEqual(without.lr_sub2, '');
  assert.strictEqual(without.ft_lr_sub2, '');

  var withId = land(visitor(), SITE + '?utm_source=aff&utm_id=web_abc&source=header_banner').pageView();
  assert.strictEqual(withId.lr_sub2, 'header_banner');
});

test('an unfilled placeholder, raw or encoded, is sent empty', function () {
  var view = land(visitor(), SITE + '?utm_source=aff&utm_id=web_abc' +
    '&lr_sub1={publisher_id}&lr_sub2=%7Bsource%7D&lr_sub3=%257BClick_Id%257D&lr_sub4=%20kept%20').pageView();
  assert.deepStrictEqual(subsOf(view), ['', '', '', 'kept', '']);
});

test('a sub value is cut at 100 characters', function () {
  var long = new Array(151).join('a');
  var view = land(visitor(), SITE + '?utm_source=aff&utm_id=web_abc&lr_sub1=' + long).pageView();
  assert.strictEqual(view.lr_sub1.length, 100);
});

test('a new campaign touch replaces every sub slot', function () {
  var v = visitor();
  land(v, SITE + '?utm_source=aff&utm_id=web_abc&lr_sub1=pub_42&lr_sub2=email&lr_sub3=c3').pageView();

  v.clock.advance(HOUR);
  var second = land(v, SITE + '?utm_source=aff2&utm_id=web_def&lr_sub1=pub_77').pageView();
  assert.deepStrictEqual(subsOf(second), ['pub_77', '', '', '', '']);

  v.clock.advance(HOUR);
  var later = land(v, SITE + 'checkout').track('purchase', { amount: 10 });
  assert.deepStrictEqual(subsOf(later), ['pub_77', '', '', '', '']);
  assert.strictEqual(later.utm_id, 'web_def');
});

test('a new ad click with no UTMs drops the partner sub slots', function () {
  var v = visitor();
  land(v, SITE + '?utm_source=aff&utm_id=web_abc&lr_sub1=pub_42').pageView();
  v.clock.advance(HOUR);
  var click = land(v, SITE + '?gclid=Cj0_new_click').pageView();
  assert.deepStrictEqual(subsOf(click), ['', '', '', '', '']);
  assert.strictEqual(click.ft_lr_sub1, 'pub_42');
});

test('sub slots expire with the last-touch UTMs', function () {
  var v = visitor();
  land(v, SITE + '?utm_source=aff&utm_id=web_abc&lr_sub1=pub_42').pageView();
  v.clock.advance(25 * HOUR);
  var later = land(v, SITE + 'checkout').track('purchase');
  assert.strictEqual(later.lr_sub1, '');
  assert.strictEqual(later.utm_id, '');
  assert.strictEqual(later.ft_lr_sub1, 'pub_42');
});

test('first-touch sub slots are kept when a later touch brings new ones', function () {
  var v = visitor();
  land(v, SITE + '?utm_source=aff&utm_id=web_abc&lr_sub1=pub_42&lr_sub2=email').pageView();
  v.clock.advance(HOUR);
  var second = land(v, SITE + '?utm_source=aff2&utm_id=web_def&lr_sub1=pub_77&lr_sub3=c3').pageView();
  assert.deepStrictEqual(subsOf(second, 'ft_'), ['pub_42', 'email', '', '', '']);
  assert.deepStrictEqual(subsOf(second), ['pub_77', '', 'c3', '', '']);
});

test('a reload of the landing does not restart or change the sub slots', function () {
  var v = visitor();
  land(v, SITE + '?utm_source=aff&utm_id=web_abc&lr_sub1=pub_42').pageView();
  v.clock.advance(HOUR);
  land(v, SITE + '?utm_source=aff2&utm_id=web_def&lr_sub1=pub_77').pageView();
  v.clock.advance(MINUTE);
  var reload = land(v, SITE + '?utm_source=aff&utm_id=web_abc&lr_sub1=pub_42', { navigationType: 'reload' }).pageView();
  assert.strictEqual(reload.lr_sub1, 'pub_77');
  assert.strictEqual(reload.utm_id, 'web_def');
});

test('the context record carries the sub slots', function () {
  var sdk = land(visitor(), SITE + '?utm_source=aff&utm_id=web_abc&lr_sub1=pub_42');
  sdk.pageView();
  var fields = JSON.parse(sdk.localStorage.getItem('lr_ctx')).fields;
  assert.strictEqual(fields.lr_sub1, 'pub_42');
  assert.strictEqual(fields.ft_lr_sub1, 'pub_42');
});
