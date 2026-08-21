'use strict';

// Proves the SHIPPED core.js produces envelopes the collector can open.
//
// The server has its own tests for the scheme, but they seal with a hand-written
// WebCrypto mirror of what core.js is supposed to do. That mirror can agree with
// the server while disagreeing with the SDK. This test closes the loop: it loads
// the real core.js, lets it seal a real page view, and decrypts the result with
// the same primitives the Node collector uses. If the two implementations drift,
// this is what catches it.

var test = require('node:test');
var assert = require('node:assert');
var nodeCrypto = require('node:crypto');
var harness = require('./helpers/sdk-harness');

var INFO_PREFIX = 'linkrunner-web-collect-v1:';
var P256_SPKI_PREFIX = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');

function generateServerKeyPair() {
  var pair = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  var spki = pair.publicKey.export({ type: 'spki', format: 'der' });

  return {
    privateKey: pair.privateKey,
    // Raw uncompressed point, base64url — the form the SDK embeds.
    publicKeyB64Url: Buffer.from(spki.subarray(spki.length - 65)).toString('base64url'),
  };
}

/** The collector's half, mirroring src/utils/web-collect/payload-crypto.ts. */
function open(envelope, server) {
  var epk = Buffer.from(envelope.epk, 'base64url');
  assert.equal(epk.length, 65, 'ephemeral key should be a raw uncompressed P-256 point');
  assert.equal(epk[0], 0x04, 'point should carry the uncompressed marker');

  var publicKey = nodeCrypto.createPublicKey({
    key: Buffer.concat([P256_SPKI_PREFIX, epk]),
    format: 'der',
    type: 'spki',
  });

  var shared = nodeCrypto.diffieHellman({ privateKey: server.privateKey, publicKey: publicKey });

  var aesKey = Buffer.from(
    nodeCrypto.hkdfSync(
      'sha256',
      shared,
      Buffer.alloc(0),
      Buffer.from(INFO_PREFIX + envelope.kid, 'utf8'),
      32
    )
  );

  var sealed = Buffer.from(envelope.ct, 'base64url');
  var ciphertext = sealed.subarray(0, sealed.length - 16);
  var tag = sealed.subarray(sealed.length - 16);

  var decipher = nodeCrypto.createDecipheriv('aes-256-gcm', aesKey, Buffer.from(envelope.iv, 'base64url'));
  decipher.setAuthTag(tag);

  return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
}

/**
 * Wait until the SDK has sent at least `count` events.
 *
 * Deadline-based, not a fixed number of turns. Sealing does an ECDH key
 * generation, and on a loaded machine that can take longer than any iteration
 * count you pick — which showed up exactly once as a phantom failure before this
 * was written. A wall-clock deadline fails only when something is actually
 * broken.
 */
async function settle(sdk, count) {
  var want = count || 1;
  var deadline = Date.now() + 5000;

  while (sdk.sent.length < want && Date.now() < deadline) {
    await new Promise(function (resolve) { setImmediate(resolve); });
  }

  assert.ok(
    sdk.sent.length >= want,
    'expected ' + want + ' event(s) within 5s, got ' + sdk.sent.length
  );
  return sdk.sent[sdk.sent.length - 1];
}

function loadEncrypted(server, extraConfig) {
  var config = {
    token: 'test_token_193',
    spa: false,
    debug: false,
    publicKey: server.publicKeyB64Url,
    keyId: 'k1',
  };
  Object.assign(config, extraConfig || {});

  return harness.loadSdk({
    url: 'https://example.com/pricing?utm_source=meta&utm_campaign=launch',
    referrer: 'https://www.facebook.com/',
    crypto: nodeCrypto.webcrypto,
    config: config,
  });
}

test('a sealed page view decrypts to the same payload the SDK would have sent', async function () {
  var server = generateServerKeyPair();
  var sdk = loadEncrypted(server);

  sdk.flush();
  var envelope = await settle(sdk);

  assert.equal(envelope.lrv, 1);
  assert.equal(envelope.kid, 'k1');
  assert.ok(envelope.epk && envelope.iv && envelope.ct);
  // The whole point: nothing readable on the wire.
  assert.equal(envelope.token, undefined);
  assert.equal(envelope.page_url, undefined);

  var payload = open(envelope, server);
  assert.equal(payload.token, 'test_token_193');
  assert.equal(payload.event_type, 'page_view');
  assert.equal(payload.page_url, 'https://example.com/pricing?utm_source=meta&utm_campaign=launch');
  assert.equal(payload.utm_source, 'meta');
  assert.equal(payload.utm_campaign, 'launch');
});

test('a custom event survives the round trip with its event_data intact', async function () {
  var server = generateServerKeyPair();
  var sdk = loadEncrypted(server);

  sdk.flush();
  await settle(sdk);

  sdk.sandbox.window.lr.track('purchase', { plan: 'prö', amount: 4999 });

  var envelope = await settle(sdk, 2);

  var payload = open(envelope, server);
  assert.equal(payload.event_name, 'purchase');
  assert.deepEqual(JSON.parse(payload.event_data), { plan: 'prö', amount: 4999 });
});

test('each event gets a fresh IV while reusing one ephemeral key per page', async function () {
  var server = generateServerKeyPair();
  var sdk = loadEncrypted(server);

  sdk.flush();
  await settle(sdk);
  sdk.sandbox.window.lr.track('one');
  sdk.sandbox.window.lr.track('two');

  await settle(sdk, 3);

  var envelopes = sdk.sent.slice(0, 3);
  assert.equal(envelopes.length, 3);

  var ivs = envelopes.map(function (e) { return e.iv; });
  assert.equal(new Set(ivs).size, 3, 'reusing an IV under one key would be a real break');

  var epks = envelopes.map(function (e) { return e.epk; });
  assert.equal(new Set(epks).size, 1, 'the expensive ECDH should happen once per page');

  envelopes.forEach(function (envelope) {
    assert.equal(open(envelope, server).token, 'test_token_193');
  });
});

test('no public key configured means plain cleartext, exactly as before', async function () {
  // The default build ships with the key constants empty, so this is what every
  // existing customer keeps doing until a keyed bundle is published.
  var sdk = harness.loadSdk({
    url: 'https://example.com/',
    crypto: nodeCrypto.webcrypto,
  });

  var payload = sdk.pageView();
  assert.equal(payload.token, 'test_token_193');
  assert.equal(payload.lrv, undefined);
});

test('falls back to cleartext rather than losing the event when WebCrypto is missing', async function () {
  // A plain http:// origin has no crypto.subtle. Encryption is configured here,
  // so the SDK must notice it cannot seal and send anyway.
  var server = generateServerKeyPair();
  var sdk = harness.loadSdk({
    url: 'http://example.com/',
    config: {
      token: 'test_token_193',
      spa: false,
      debug: false,
      publicKey: server.publicKeyB64Url,
      keyId: 'k1',
    },
  });

  sdk.flush();
  var payload = await settle(sdk);

  assert.equal(payload.token, 'test_token_193');
  assert.equal(payload.event_type, 'page_view');
  assert.equal(payload.lrv, undefined);
});

test('an unusable public key does not take events down with it', async function () {
  var sdk = harness.loadSdk({
    url: 'https://example.com/',
    crypto: nodeCrypto.webcrypto,
    config: {
      token: 'test_token_193',
      spa: false,
      debug: false,
      publicKey: 'not-a-real-key',
      keyId: 'k1',
    },
  });

  sdk.flush();
  var payload = await settle(sdk);

  assert.equal(payload.token, 'test_token_193');
  assert.equal(payload.lrv, undefined);
});
