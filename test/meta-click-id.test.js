'use strict';

// Click-ID lifetime.
//
// Click IDs were stored for 90 days regardless of network, so a Meta click from
// 23 June was still being replayed on 14 August — 52 days later — and credited
// to Meta on LAST touch, long after Meta itself had stopped counting it. Each
// network now expires at its own attribution window.
//
// Note what is deliberately NOT tested here: crediting Meta from the `_fbc`
// cookie. Unlike `gclid`, Facebook appends `fbclid` to outbound clicks from its
// properties generally — organic posts, shares, link-in-bio — so a click ID
// cannot separate paid from organic and must not decide `traffic_source_type`.
//
// Click IDs here are synthetic; never paste a real one into a test.

var test = require('node:test');
var assert = require('node:assert');
var h = require('./helpers/sdk-harness');

var DAY = 24 * h.HOUR;

test('a stored Meta click ID expires after 7 days, not 90', function () {
  var clock = h.createClock();
  var storage = h.createStorage();

  // Visit 1: a real Meta ad click, click ID persisted.
  var first = h.loadSdk({
    url: 'https://playo.co/?fbclid=IwY2xjawSYNTHETIC',
    referrer: 'https://l.facebook.com/',
    localStorage: storage,
    clock: clock,
  });
  assert.strictEqual(first.pageView().traffic_source_name, 'meta');

  // Visit 2, eight days later, arriving from Google with no campaign params.
  // The old Meta click is outside Meta's window and must not be replayed.
  clock.advance(8 * DAY);
  var later = h.loadSdk({
    url: 'https://playo.co/',
    referrer: 'https://www.google.com/',
    localStorage: storage,
    sessionStorage: h.createStorage(),
    clock: clock,
  });

  var payload = later.pageView();
  assert.notStrictEqual(payload.traffic_source_name, 'meta');
  assert.strictEqual(payload.fbclid, '');
});

test('a stored Meta click ID still counts inside the 7-day window', function () {
  var clock = h.createClock();
  var storage = h.createStorage();

  h.loadSdk({
    url: 'https://playo.co/?fbclid=IwY2xjawSYNTHETIC',
    referrer: 'https://l.facebook.com/',
    localStorage: storage,
    clock: clock,
  }).pageView();

  clock.advance(6 * DAY);
  var later = h.loadSdk({
    url: 'https://playo.co/',
    referrer: '',
    localStorage: storage,
    sessionStorage: h.createStorage(),
    clock: clock,
  });
  assert.strictEqual(later.pageView().traffic_source_name, 'meta');
});

test('a stored Google click ID still lives the full 90 days', function () {
  var clock = h.createClock();
  var storage = h.createStorage();

  var first = h.loadSdk({
    url: 'https://playo.co/?gclid=Cj0KCQSYNTHETIC',
    referrer: 'https://www.google.com/',
    localStorage: storage,
    clock: clock,
  });
  assert.strictEqual(first.pageView().traffic_source_name, 'google');

  clock.advance(30 * DAY);
  var later = h.loadSdk({
    url: 'https://playo.co/',
    referrer: '',
    localStorage: storage,
    sessionStorage: h.createStorage(),
    clock: clock,
  });
  assert.strictEqual(later.pageView().gclid, 'Cj0KCQSYNTHETIC');
});

test('a Meta click ID alone never outranks a genuine later Google click', function () {
  var clock = h.createClock();
  var storage = h.createStorage();

  h.loadSdk({
    url: 'https://playo.co/?fbclid=IwY2xjawSYNTHETIC',
    referrer: 'https://l.facebook.com/',
    localStorage: storage,
    clock: clock,
  }).pageView();

  clock.advance(2 * DAY);
  var viaGoogle = h.loadSdk({
    url: 'https://playo.co/venues?gclid=Cj0KCQSYNTHETIC',
    referrer: 'https://www.google.com/',
    localStorage: storage,
    sessionStorage: h.createStorage(),
    clock: clock,
  });

  var payload = viaGoogle.pageView();
  assert.strictEqual(payload.traffic_source_type, 'paid_search');
  assert.strictEqual(payload.traffic_source_name, 'google');
});
