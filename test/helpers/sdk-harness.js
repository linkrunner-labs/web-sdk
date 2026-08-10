'use strict';

// Loads src/core.js into a throwaway browser-ish sandbox so attribution behaviour can
// be asserted without a headless browser. Each loadSdk() call is one page load: pass the
// same localStorage object (and a fresh sessionStorage) to simulate a new tab, which is
// exactly what a payment gateway round trip does to a visitor.

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var CORE_PATH = path.join(__dirname, '..', '..', 'src', 'core.js');
var CORE_SOURCE = fs.readFileSync(CORE_PATH, 'utf8');

var MINUTE = 60 * 1000;
var HOUR = 60 * MINUTE;

function createStorage(initial) {
  var data = new Map(Object.entries(initial || {}));
  return {
    // Flip these to emulate Safari private mode / quota exhaustion.
    failReads: false,
    failWrites: false,
    getItem: function (key) {
      if (this.failReads) throw new Error('SecurityError: storage unavailable');
      return data.has(key) ? data.get(key) : null;
    },
    setItem: function (key, value) {
      if (this.failWrites) throw new Error('QuotaExceededError');
      data.set(key, String(value));
    },
    removeItem: function (key) {
      if (this.failWrites) throw new Error('QuotaExceededError');
      data.delete(key);
    },
    keys: function () {
      return Array.from(data.keys());
    },
    raw: data,
  };
}

function createClock(start) {
  return {
    now: start || Date.parse('2026-08-08T10:00:00.000Z'),
    advance: function (ms) {
      this.now += ms;
      return this.now;
    },
  };
}

function createDateClass(clock) {
  return class FakeDate extends Date {
    constructor() {
      if (arguments.length === 0) {
        super(clock.now);
      } else {
        super(...arguments);
      }
    }
    static now() {
      return clock.now;
    }
  };
}

function loadSdk(options) {
  var url = options.url;
  var referrer = options.referrer || '';
  var clock = options.clock || createClock();
  var localStorage = options.localStorage || createStorage();
  var sessionStorage = options.sessionStorage || createStorage();
  var cookie = options.cookie || '';

  var parsed = new URL(url);
  var sent = [];
  var timers = [];

  var sandbox = {
    location: {
      href: parsed.href,
      pathname: parsed.pathname,
      search: parsed.search,
      hash: parsed.hash,
      hostname: parsed.hostname,
    },
    document: {
      currentScript: null,
      querySelector: function () {
        return null;
      },
      addEventListener: function () {},
      readyState: 'complete',
      referrer: referrer,
      title: 'Playo',
      cookie: cookie,
    },
    navigator: {
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1',
      language: 'en-US',
      languages: ['en-US'],
      platform: 'iPhone',
      cookieEnabled: true,
      maxTouchPoints: 5,
      hardwareConcurrency: 4,
    },
    screen: { width: 390, height: 844, colorDepth: 24 },
    history: { pushState: function () {}, replaceState: function () {} },
    performance: {
      getEntriesByType: function () {
        return [];
      },
    },
    crypto: {
      getRandomValues: function (bytes) {
        for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
        return bytes;
      },
    },
    localStorage: localStorage,
    sessionStorage: sessionStorage,
    console: console,
    Intl: Intl,
    URL: URL,
    Date: createDateClass(clock),
    fetch: function (endpoint, init) {
      sent.push(JSON.parse(init.body));
      return Promise.resolve({});
    },
    setTimeout: function (fn) {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: function () {},
    addEventListener: function () {},
    innerWidth: 390,
    innerHeight: 844,
    devicePixelRatio: 3,
    LinkrunnerConfig: { token: 'test_token_193', spa: false, debug: false },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(CORE_SOURCE, sandbox, { filename: CORE_PATH });

  function flush() {
    while (timers.length) timers.shift()();
  }

  return {
    sandbox: sandbox,
    sent: sent,
    clock: clock,
    localStorage: localStorage,
    sessionStorage: sessionStorage,
    flush: flush,
    // Fires the deferred initial page view and returns its payload.
    pageView: function () {
      flush();
      return sent[sent.length - 1];
    },
    track: function (name, data) {
      sandbox.window.lr.track(name, data);
      return sent[sent.length - 1];
    },
  };
}

module.exports = {
  MINUTE: MINUTE,
  HOUR: HOUR,
  createClock: createClock,
  createStorage: createStorage,
  loadSdk: loadSdk,
};
