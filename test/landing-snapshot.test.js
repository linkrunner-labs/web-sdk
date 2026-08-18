'use strict';

// Landing snapshot recovery.
//
// The SDK reads `location.search` exactly once, when it executes. Loaded with
// Next.js `strategy="afterInteractive"` (or any async tag) it executes AFTER
// hydration, and on a slow in-app browser the visitor has often already tapped
// through to a second page by then — where there is no query string at all, so
// the campaign is lost for the whole visit with no second chance. Measured on
// Meta's in-app browser, time-to-interactive was 742ms against 316ms on the
// visits that were captured.
//
// The npm stub (`src/index.ts`) records the landing URL synchronously at
// module-evaluation time, before hydration. These tests cover `core.js` reading
// that snapshot back.
//
// The stub is simulated by pre-seeding sessionStorage, which is exactly what it
// leaves behind.

var test = require('node:test');
var assert = require('node:assert');
var h = require('./helpers/sdk-harness');

var LANDING =
  'https://playo.co/venues?utm_source=ig&utm_medium=paid_social&utm_campaign=TOF-Sale&utm_id=52535304512447';
var SECOND_PAGE = 'https://playo.co/venues/panaiyur/funfit-pickleball-panaiyur-chennai';

function withSnapshot(href, referrer) {
  var url = new URL(href);
  return h.createStorage({
    lr_snap: JSON.stringify({ href: href, search: url.search, referrer: referrer || '' }),
  });
}

test('recovers the campaign when the SDK boots on the second page', function () {
  // The visitor landed on the tagged URL, tapped a venue card, and only then did
  // the script execute — on a page with no query string.
  var sdk = h.loadSdk({
    url: SECOND_PAGE,
    referrer: 'https://l.instagram.com/',
    sessionStorage: withSnapshot(LANDING, 'https://l.instagram.com/'),
  });

  var payload = sdk.pageView();
  assert.strictEqual(payload.utm_source, 'ig');
  assert.strictEqual(payload.utm_medium, 'paid_social');
  assert.strictEqual(payload.utm_id, '52535304512447');
  // The SDK's own classifier maps utm_medium=paid_social to `social` — the
  // backend's Meta fold is what completes it to paid_social/meta. What matters
  // here is that the campaign parameters survived at all; without the snapshot
  // every one of these fields is empty.
  assert.strictEqual(payload.traffic_source_name, 'ig');
});

test('reports the real landing page, not the page it happened to boot on', function () {
  var sdk = h.loadSdk({
    url: SECOND_PAGE,
    referrer: 'https://l.instagram.com/',
    sessionStorage: withSnapshot(LANDING, 'https://l.instagram.com/'),
  });

  assert.strictEqual(sdk.pageView().entry_page, LANDING);
});

test('persists the recovered campaign for later events in the visit', function () {
  var sdk = h.loadSdk({
    url: SECOND_PAGE,
    referrer: 'https://l.instagram.com/',
    sessionStorage: withSnapshot(LANDING, 'https://l.instagram.com/'),
  });
  sdk.pageView();

  var purchase = sdk.track('purchase', { value: 400 });
  assert.strictEqual(purchase.utm_id, '52535304512447');
  assert.strictEqual(purchase.utm_source, 'ig');
  assert.strictEqual(purchase.utm_medium, 'paid_social');
});

test('the live URL always wins when it still carries parameters', function () {
  // A snapshot from an earlier, differently-tagged arrival must never override
  // the campaign the visitor is on right now.
  var sdk = h.loadSdk({
    url: 'https://playo.co/venues?utm_source=google&utm_medium=cpc&utm_id=999',
    referrer: 'https://www.google.com/',
    sessionStorage: withSnapshot(LANDING, 'https://l.instagram.com/'),
  });

  var payload = sdk.pageView();
  assert.strictEqual(payload.utm_source, 'google');
  assert.strictEqual(payload.utm_id, '999');
});

test('recovers the referrer when the live one has been lost', function () {
  var sdk = h.loadSdk({
    url: SECOND_PAGE,
    referrer: '',
    sessionStorage: withSnapshot(SECOND_PAGE, 'https://l.instagram.com/'),
  });

  assert.strictEqual(sdk.pageView().referring_domain, 'l.instagram.com');
});

test('behaves exactly as before when no stub has run', function () {
  var sdk = h.loadSdk({ url: LANDING, referrer: 'https://l.instagram.com/' });

  var payload = sdk.pageView();
  assert.strictEqual(payload.utm_source, 'ig');
  assert.strictEqual(payload.entry_page, LANDING);
});

test('survives a malformed snapshot rather than throwing', function () {
  var sdk = h.loadSdk({
    url: LANDING,
    referrer: '',
    sessionStorage: h.createStorage({ lr_snap: 'not-json' }),
  });

  assert.strictEqual(sdk.pageView().utm_source, 'ig');
});
