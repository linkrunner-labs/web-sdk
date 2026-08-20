'use strict';

// A site moving to its own domain changes one thing — the script src. The
// endpoint follows, because on a CNAME'd subdomain we serve both routes from the
// same host. These pin the cases where it must NOT follow.

var test = require('node:test');
var assert = require('node:assert');
var harness = require('./helpers/sdk-harness');

function endpointFor(scriptSrc, config) {
  var sdk = harness.loadSdk({
    url: 'https://playo.co/venues',
    scriptSrc: scriptSrc,
    config: Object.assign({ token: 'test_token_193', spa: false, debug: false }, config || {}),
  });
  sdk.flush();
  return sdk.sentTo[0];
}

test('a CNAMEd subdomain serves the collector, so the endpoint follows the script', function () {
  assert.equal(
    endpointFor('https://app.playo.co/web/v1/lr.js'),
    'https://app.playo.co/web/ingest'
  );
});

test('our own CDN serves no collector, so it never derives', function () {
  assert.equal(
    endpointFor('https://cdn.linkrunner.io/web/v1/lr.js'),
    'https://api.linkrunner.io/web/ingest'
  );
});

test('a self-chosen proxy path does not imply a collector path', function () {
  // Option 1 in the README: the site picked /lr/lr.js, so it picked its own
  // collector path too. Guessing /web/ingest here would be wrong.
  assert.equal(
    endpointFor('https://playo.co/lr/lr.js'),
    'https://api.linkrunner.io/web/ingest'
  );
});

test('explicit config still wins over derivation', function () {
  assert.equal(
    endpointFor('https://app.playo.co/web/v1/lr.js', { endpoint: '/lr/ingest' }),
    '/lr/ingest'
  );
});

test('no script tag at all falls back to the default', function () {
  assert.equal(endpointFor(null), 'https://api.linkrunner.io/web/ingest');
});
