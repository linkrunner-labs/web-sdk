(function(window, document) {
  'use strict';

  // Bail in non-browser environments (SSR)
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  // ============================================================
  // CONFIGURATION
  // ============================================================

  var scriptTag = document.currentScript || document.querySelector('script[data-token]');
  var configObj = window.LinkrunnerConfig || {};

  var TOKEN = configObj.token
    || (scriptTag && scriptTag.getAttribute('data-token'))
    || '';

  if (!TOKEN) return;

  // Deliberately NOT '/web/collect'. "collect" is Google Analytics' collector
  // path, so every mainstream blocklist (EasyPrivacy, AdGuard Tracking
  // Protection, Brave) matches the token generically — the beacon was being
  // dropped in the browser before it ever reached us. '/web/ingest' carries no
  // tracker keyword. The server still answers on '/web/collect' for pages
  // running an older cached bundle, so never point this back at it.
  var DEFAULT_ENDPOINT = 'https://api.linkrunner.io/web/ingest';

  /**
   * First-party collection endpoints, keyed by write token.
   *
   * Moving off '/web/collect' stops a blocklist matching on the word
   * "collect"; it does nothing about a list entry for our DOMAIN, and those
   * exist. The only thing that survives one is collecting from a host the site
   * already owns, so these are subdomains the customer has CNAME'd to
   * api.linkrunner.io.
   *
   * Why a table in the bundle rather than an attribute on the script tag: the
   * attribute is the better mechanism and it already exists (`data-endpoint`),
   * but using it means the customer edits their page, and everyone already
   * integrated keeps sending to the blocked domain until they get round to it.
   * The table moves them without their doing anything, because the bundle is
   * served from our CDN behind a `max-age=0, must-revalidate` alias.
   *
   * Adding an entry has a hard prerequisite: the host must already answer POST
   * /web/ingest. A CNAME and a certificate are not enough — the LB hands
   * unmatched paths to the branded-link handler, which is GET-only and answers
   * 405 to both the preflight and the POST. Check before shipping an entry:
   *
   *   curl -i -X OPTIONS -H 'Origin: https://<site>' \
   *     -H 'Access-Control-Request-Method: POST' https://<host>/web/ingest
   *
   * and expect 204 with access-control-allow-origin. If it is wrong the events
   * are not lost (see shouldFallBack) but each one costs a doomed round trip.
   *
   * This is a stopgap for customers integrated before `data-endpoint` existed.
   * New integrations get the attribute and stay out of this table.
   */
  var FIRST_PARTY_ENDPOINTS = {
    // Playo, on their existing branded-link host.
    'lr_web_fyy3R021a1IgsYS7p1CIwJta': 'https://app.playo.co/web/ingest'
  };

  // typeof-guarded because the token indexes an object literal: a token of
  // 'constructor' or 'toString' would otherwise resolve up the prototype chain
  // to a function and be handed to fetch as a URL.
  var MAPPED_ENDPOINT = typeof FIRST_PARTY_ENDPOINTS[TOKEN] === 'string'
    ? FIRST_PARTY_ENDPOINTS[TOKEN]
    : '';

  // An explicit endpoint outranks the table, so a customer in it can still be
  // moved or reverted from their own page without waiting on a bundle release.
  var COLLECT_ENDPOINT = configObj.endpoint
    || (scriptTag && scriptTag.getAttribute('data-endpoint'))
    || MAPPED_ENDPOINT
    || DEFAULT_ENDPOINT;

  // Payload encryption, off unless a key is configured.
  //
  // Read this before turning it on: it does NOTHING about ad blockers. They
  // cancel the request in onBeforeRequest, from the URL — there is never a body
  // for them to read, encrypted or not. What survives a blocker is a
  // first-party request URL (see the README), not an unreadable payload.
  //
  // What it does buy: the payload names page URLs, referrers, a visitor id and
  // whatever event_data the site attaches. TLS protects that from the network,
  // but TLS terminates at every hop holding a certificate — the site's own
  // reverse proxy in a first-party setup, a corporate MITM appliance. Sealing to
  // a key only the server holds closes that gap and keeps the event schema off
  // the wire.
  //
  // These two constants are empty here and filled in at release. Empty means no
  // encryption, which is exactly the behaviour that shipped before this existed;
  // there is deliberately no placeholder key, because a wrong key would produce
  // envelopes nothing can decrypt and lose events silently.
  var SERVER_PUBLIC_KEY = '';
  var SERVER_KEY_ID = '';

  var ENCRYPTION_PUBLIC_KEY = configObj.publicKey
    || (scriptTag && scriptTag.getAttribute('data-public-key'))
    || SERVER_PUBLIC_KEY;

  var ENCRYPTION_KEY_ID = configObj.keyId
    || (scriptTag && scriptTag.getAttribute('data-key-id'))
    || SERVER_KEY_ID;

  // Shared verbatim with the server's payload-crypto.ts. Change it on one side
  // and every envelope silently fails to decrypt on the other.
  var ENCRYPTION_INFO_PREFIX = 'linkrunner-web-collect-v1:';

  var ENCRYPTION_ENABLED = !!(ENCRYPTION_PUBLIC_KEY && ENCRYPTION_KEY_ID);

  var SPA_ENABLED = configObj.spa !== false
    && !(scriptTag && scriptTag.getAttribute('data-spa') === 'false');

  var DEBUG = (function() {
    if (configObj.debug === true) return true;
    if (configObj.debug === false) return false;
    if (scriptTag && scriptTag.getAttribute('data-debug') === 'true') return true;
    if (scriptTag && scriptTag.getAttribute('data-debug') === 'false') return false;
    try {
      var h = location.hostname;
      return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
    } catch (e) { return false; }
  })();

  var CLICK_ID_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

  // Last-touch UTMs get a much shorter life than click IDs: 24 hours from the campaign
  // click. Long enough for a payment gateway round trip and a browse-then-buy journey
  // that outlives the tab, short enough that a campaign is never credited for a visit
  // days later — and well inside every ad platform's click-through window.
  var LAST_TOUCH_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours since the campaign click

  // ============================================================
  // CONSTANTS
  // ============================================================

  // utm_id is the stable per-campaign identifier (e.g. Meta's {{campaign.id}} in
  // its default URL template) — the web analogue of an app campaign's display_id.
  // Including it here persists it last-touch (sessionStorage) + first-touch
  // (localStorage, as ft_utm_id) and ships both on every event, so the dashboard
  // can group a campaign's links by utm_id even after the landing page view.
  var UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_id', 'utm_term', 'utm_content'];

  var CLICK_ID_KEYS = [
    'gclid', 'gbraid', 'wbraid', 'fbclid', 'fbc', 'fbp',
    'ttclid', 'twclid', 'msclkid', 'li_fat_id', 'dclid', 'irclickid'
  ];

  var AI_SEARCH_DOMAINS = {
    'chatgpt.com': 'chatgpt', 'chat.openai.com': 'chatgpt',
    'perplexity.ai': 'perplexity',
    'claude.ai': 'claude',
    'gemini.google.com': 'gemini', 'bard.google.com': 'gemini',
    'copilot.microsoft.com': 'copilot',
    'meta.ai': 'meta_ai', 'www.meta.ai': 'meta_ai',
    'grok.com': 'grok', 'grok.x.com': 'grok', 'x.ai': 'grok',
    'deepseek.com': 'deepseek',
    'mistral.ai': 'mistral', 'chat.mistral.ai': 'mistral',
    'you.com': 'you',
    'phind.com': 'phind',
    'kagi.com': 'kagi'
  };

  var SEARCH_ENGINE_DOMAINS = {
    'google.com': 'google', 'www.google.com': 'google',
    'bing.com': 'bing', 'www.bing.com': 'bing',
    'yahoo.com': 'yahoo', 'search.yahoo.com': 'yahoo',
    'duckduckgo.com': 'duckduckgo',
    'baidu.com': 'baidu', 'www.baidu.com': 'baidu',
    'yandex.com': 'yandex', 'yandex.ru': 'yandex',
    'ecosia.org': 'ecosia', 'www.ecosia.org': 'ecosia',
    'search.brave.com': 'brave',
    'naver.com': 'naver'
  };

  var SOCIAL_DOMAINS = {
    'facebook.com': 'facebook', 'www.facebook.com': 'facebook', 'm.facebook.com': 'facebook', 'l.facebook.com': 'facebook',
    'instagram.com': 'instagram', 'www.instagram.com': 'instagram', 'l.instagram.com': 'instagram',
    'twitter.com': 'twitter', 'www.twitter.com': 'twitter',
    'x.com': 'twitter', 'www.x.com': 'twitter', 't.co': 'twitter',
    'linkedin.com': 'linkedin', 'www.linkedin.com': 'linkedin', 'lnkd.in': 'linkedin',
    'pinterest.com': 'pinterest', 'www.pinterest.com': 'pinterest',
    'reddit.com': 'reddit', 'www.reddit.com': 'reddit', 'old.reddit.com': 'reddit',
    'tiktok.com': 'tiktok', 'www.tiktok.com': 'tiktok',
    'youtube.com': 'youtube', 'www.youtube.com': 'youtube', 'm.youtube.com': 'youtube',
    'snapchat.com': 'snapchat', 'www.snapchat.com': 'snapchat'
  };

  var BOT_PATTERN = /bot|crawl|spider|slurp|facebookexternalhit|Googlebot|bingbot|yandex|baidu|duckduckgo|ia_archiver|pingdom|uptimerobot|headless|phantom|selenium|puppeteer|playwright|GPTBot|ChatGPT-User|ClaudeBot|PerplexityBot|Applebot/i;

  // ============================================================
  // LOGGER
  // ============================================================

  function log(label, data) {
    if (!DEBUG) return;
    if (data !== undefined) {
      console.log('[Linkrunner] ' + label, data);
    } else {
      console.log('[Linkrunner] ' + label);
    }
  }

  function logError(label, error) {
    if (!DEBUG) return;
    // Mirrors log(): some callers report a condition rather than an exception,
    // and appending a bare `undefined` to those makes the console harder to read.
    if (error !== undefined) {
      console.error('[Linkrunner] ' + label, error);
    } else {
      console.error('[Linkrunner] ' + label);
    }
  }

  // ============================================================
  // UTILITIES
  // ============================================================

  function generateUUID() {
    try {
      var bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      var hex = [];
      for (var i = 0; i < 16; i++) {
        hex.push(('0' + bytes[i].toString(16)).slice(-2));
      }
      return hex[0]+hex[1]+hex[2]+hex[3]+'-'+hex[4]+hex[5]+'-'+hex[6]+hex[7]+'-'+hex[8]+hex[9]+'-'+hex[10]+hex[11]+hex[12]+hex[13]+hex[14]+hex[15];
    } catch (e) {
      logError('crypto.getRandomValues failed, using Math.random fallback', e);
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
    }
  }

  function getQueryParams() {
    var params = {};
    try {
      var search = window.location.search.substring(1);
      if (!search) return params;
      var pairs = search.split('&');
      for (var i = 0; i < pairs.length; i++) {
        var pair = pairs[i].split('=');
        if (pair[0]) {
          params[decodeURIComponent(pair[0])] = pair[1] ? decodeURIComponent(pair[1]) : '';
        }
      }
    } catch (e) { logError('Failed to parse query params', e); }
    return params;
  }

  function getReferringDomain(referrer) {
    if (!referrer) return '';
    try { return new URL(referrer).hostname; } catch (e) { logError('Failed to parse referrer URL', e); return ''; }
  }

  function getCanonicalUrl() {
    try {
      var link = document.querySelector('link[rel="canonical"]');
      return link ? link.getAttribute('href') || '' : '';
    } catch (e) { logError('Failed to get canonical URL', e); return ''; }
  }

  function safeGet(storage, key) {
    try { return storage.getItem(key); } catch (e) { logError('Storage read failed for ' + key, e); return null; }
  }

  function safeSet(storage, key, value) {
    try { storage.setItem(key, value); } catch (e) { logError('Storage write failed for ' + key, e); }
  }

  function safeRemove(storage, key) {
    try { storage.removeItem(key); } catch (e) { logError('Storage remove failed for ' + key, e); }
  }

  function getCookie(name) {
    try {
      var match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
      return match ? decodeURIComponent(match[1]) : '';
    } catch (e) { logError('Cookie read failed for ' + name, e); return ''; }
  }

  function setCookie(name, value, days) {
    try {
      var expires = new Date(Date.now() + days * 864e5).toUTCString();
      document.cookie = name + '=' + encodeURIComponent(value) + '; expires=' + expires + '; path=/; SameSite=Lax';
    } catch (e) { logError('Cookie write failed for ' + name, e); }
  }

  // ============================================================
  // IDENTITY MANAGER
  // ============================================================

  function getOrCreateId(storage, key) {
    var id = safeGet(storage, key);
    if (id) return { id: id, isNew: false };
    id = generateUUID();
    safeSet(storage, key, id);
    return { id: id, isNew: true };
  }

  var visitor = getOrCreateId(localStorage, 'lr_vid');
  var session = getOrCreateId(sessionStorage, 'lr_sid');
  log('Identity', { visitor_id: visitor.id, new_visitor: visitor.isNew, session_id: session.id });

  // User ID (set via lr.identify)
  function getUserId() {
    return safeGet(localStorage, 'lr_uid') || '';
  }

  function setUserId(userId) {
    if (userId && typeof userId === 'string') {
      safeSet(localStorage, 'lr_uid', userId);
    }
  }

  // ============================================================
  // CLICK ID PERSISTENCE (localStorage, 90-day TTL)
  // ============================================================

  function setClickId(key, value) {
    safeSet(localStorage, 'lr_' + key, JSON.stringify({ v: value, t: Date.now() }));
  }

  function getClickId(key) {
    try {
      var raw = safeGet(localStorage, 'lr_' + key);
      if (!raw) return '';
      var parsed = JSON.parse(raw);
      if (Date.now() - parsed.t > CLICK_ID_TTL_MS) {
        safeRemove(localStorage, 'lr_' + key);
        return '';
      }
      return parsed.v || '';
    } catch (e) { logError('Failed to parse click ID ' + key, e); return ''; }
  }

  function setFirstTouchClickId(key, value) {
    var ftKey = 'lr_ft_' + key;
    if (!safeGet(localStorage, ftKey) && value) {
      safeSet(localStorage, ftKey, value);
    }
  }

  function getFirstTouchClickId(key) {
    return safeGet(localStorage, 'lr_ft_' + key) || '';
  }

  // Expire old click IDs on init
  function expireOldClickIds() {
    for (var i = 0; i < CLICK_ID_KEYS.length; i++) {
      getClickId(CLICK_ID_KEYS[i]); // triggers expiry check
    }
  }

  // ============================================================
  // UTM PERSISTENCE (sessionStorage + short-lived localStorage record for
  // last-touch, localStorage for first-touch)
  // ============================================================

  // Last-touch UTMs are mirrored into a stamped localStorage record (lr_lt) as well as
  // sessionStorage, because sessionStorage is per tab: a payment gateway that returns
  // the visitor in a fresh tab wipes it, and the purchase lands with empty campaign
  // fields even though the click IDs (90-day localStorage) still say "meta". The record
  // is deliberately short-lived — see LAST_TOUCH_TTL_MS.

  function setFirstTouchUtm(key, value) {
    var ftKey = 'lr_ft_' + key;
    if (!safeGet(localStorage, ftKey) && value) {
      safeSet(localStorage, ftKey, value);
    }
  }

  function getFirstTouchUtm(key) {
    return safeGet(localStorage, 'lr_ft_' + key) || '';
  }

  // Returns the stored last-touch record, or null when it is absent or expired. An
  // expired record clears the sessionStorage mirror as well, so the window means the
  // same thing whether or not the visitor's tab survived.
  function getLastTouchRecord() {
    var raw = safeGet(localStorage, 'lr_lt');
    if (!raw) return null;
    try {
      var record = JSON.parse(raw);
      if (!record || !record.u) return null;
      // A record with no usable stamp can never expire: Date.now() - undefined is
      // NaN, and NaN > TTL is false, so the window below would be skipped forever.
      // Treat it as expired instead — the TTL is the only thing keeping a campaign
      // from being credited indefinitely.
      if (typeof record.t !== 'number' || !isFinite(record.t)) {
        log('Last-touch UTM record has no valid timestamp — discarding', record.u);
        clearLastTouchUtms();
        return null;
      }
      if (Date.now() - record.t > LAST_TOUCH_TTL_MS) {
        log('Last-touch UTMs expired', record.u);
        clearLastTouchUtms();
        return null;
      }
      return record;
    } catch (e) { logError('Failed to parse last-touch UTM record', e); return null; }
  }

  // Replaces the stored set wholesale — a campaign link carrying fewer params must not
  // inherit leftover fields from the previous campaign.
  function setLastTouchUtms(utms) {
    for (var i = 0; i < UTM_KEYS.length; i++) {
      var key = UTM_KEYS[i];
      if (utms[key]) {
        safeSet(sessionStorage, 'lr_' + key, utms[key]);
      } else {
        safeRemove(sessionStorage, 'lr_' + key);
      }
    }
    safeSet(localStorage, 'lr_lt', JSON.stringify({ u: utms, t: Date.now() }));
  }

  function clearLastTouchUtms() {
    for (var i = 0; i < UTM_KEYS.length; i++) {
      safeRemove(sessionStorage, 'lr_' + UTM_KEYS[i]);
    }
    safeRemove(localStorage, 'lr_lt');
  }

  // ============================================================
  // PARAMETER PERSISTENCE — extract from URL, persist to storage
  // ============================================================

  function persistParams() {
    var params = getQueryParams();
    var foundUtms = {};
    var foundClickIds = {};
    var newClickIdInUrl = false;

    // UTMs → first-touch here, last-touch below (written as one set)
    for (var i = 0; i < UTM_KEYS.length; i++) {
      var key = UTM_KEYS[i];
      if (params[key]) {
        foundUtms[key] = params[key];
        setFirstTouchUtm(key, params[key]);
      }
    }

    // Click IDs → localStorage (last-touch with TTL)
    for (var j = 0; j < CLICK_ID_KEYS.length; j++) {
      var cidKey = CLICK_ID_KEYS[j];
      if (params[cidKey]) {
        if (params[cidKey] !== getClickId(cidKey)) newClickIdInUrl = true;
        foundClickIds[cidKey] = params[cidKey];
        setClickId(cidKey, params[cidKey]);
        setFirstTouchClickId(cidKey, params[cidKey]);
      }
    }

    // Meta cookies — fall back to document.cookie if not found in URL params
    if (!foundClickIds.fbp) {
      var fbpCookie = getCookie('_fbp');
      if (fbpCookie) {
        foundClickIds.fbp = fbpCookie;
        setClickId('fbp', fbpCookie);
        setFirstTouchClickId('fbp', fbpCookie);
      }
    }
    if (!foundClickIds.fbc) {
      var fbcCookie = getCookie('_fbc');
      if (fbcCookie) {
        foundClickIds.fbc = fbcCookie;
        setClickId('fbc', fbcCookie);
        setFirstTouchClickId('fbc', fbcCookie);
      }
    }

    // Write _fbc cookie from fbclid in Meta's standard format
    if (params.fbclid) {
      var fbcValue = 'fb.1.' + Date.now() + '.' + params.fbclid;
      setCookie('_fbc', fbcValue, 90);
      if (!foundClickIds.fbc) {
        foundClickIds.fbc = fbcValue;
        setClickId('fbc', fbcValue);
        setFirstTouchClickId('fbc', fbcValue);
      }
    }

    // Only an arrival that actually carries campaign params rewrites last-touch state.
    // Navigation with no campaign params — a payment gateway sending the visitor back —
    // leaves the stored set alone, which is what keeps attribution across the redirect.
    if (Object.keys(foundUtms).length) {
      setLastTouchUtms(foundUtms);
      log('UTM params found', foundUtms);
    } else if (newClickIdInUrl) {
      // A new click that carries no UTMs is still a new touch: drop the previous
      // campaign's UTMs rather than crediting them to this click.
      clearLastTouchUtms();
    }

    if (Object.keys(foundClickIds).length) log('Click IDs found', foundClickIds);
  }

  // The stamped record wins as a complete set while it is valid; otherwise we fall back
  // to sessionStorage, which keeps visitors who upgrade mid-session — and visitors whose
  // localStorage is unavailable — on the pre-existing behaviour.
  function getPersistedUtms() {
    var record = getLastTouchRecord();
    var utms = {};
    for (var i = 0; i < UTM_KEYS.length; i++) {
      var key = UTM_KEYS[i];
      utms[key] = (record ? record.u[key] : safeGet(sessionStorage, 'lr_' + key)) || '';
    }
    return utms;
  }

  function getFirstTouchUtms() {
    var utms = {};
    for (var i = 0; i < UTM_KEYS.length; i++) {
      utms['ft_' + UTM_KEYS[i]] = getFirstTouchUtm(UTM_KEYS[i]);
    }
    return utms;
  }

  function getPersistedClickIds() {
    var ids = {};
    for (var i = 0; i < CLICK_ID_KEYS.length; i++) {
      ids[CLICK_ID_KEYS[i]] = getClickId(CLICK_ID_KEYS[i]);
    }
    return ids;
  }

  function getFirstTouchClickIds() {
    var ids = {};
    for (var i = 0; i < CLICK_ID_KEYS.length; i++) {
      ids['ft_' + CLICK_ID_KEYS[i]] = getFirstTouchClickId(CLICK_ID_KEYS[i]);
    }
    return ids;
  }

  // ============================================================
  // TRAFFIC SOURCE CLASSIFICATION
  // ============================================================

  function classifyTrafficSource(clickIds, utms, referringDomain) {
    // 1. Click ID based (paid traffic)
    if (clickIds.gclid || clickIds.gbraid || clickIds.wbraid) return { type: 'paid_search', name: 'google' };
    if (clickIds.fbclid) return { type: 'paid_social', name: 'meta' };
    if (clickIds.msclkid) return { type: 'paid_search', name: 'microsoft' };
    if (clickIds.ttclid) return { type: 'paid_social', name: 'tiktok' };
    if (clickIds.twclid) return { type: 'paid_social', name: 'twitter' };
    if (clickIds.li_fat_id) return { type: 'paid_social', name: 'linkedin' };
    if (clickIds.dclid) return { type: 'paid_display', name: 'google' };
    if (clickIds.irclickid) return { type: 'paid_affiliate', name: 'impact' };

    // 2. UTM medium based
    if (utms.utm_medium) {
      var medium = utms.utm_medium.toLowerCase();
      if (medium === 'cpc' || medium === 'ppc' || medium === 'paidsearch' || medium === 'paid_search' || medium === 'sem') {
        return { type: 'paid_search', name: utms.utm_source || 'unknown' };
      }
      if (medium === 'cpm' || medium === 'display' || medium === 'banner') {
        return { type: 'paid_display', name: utms.utm_source || 'unknown' };
      }
      if (medium === 'email' || medium === 'e-mail') {
        return { type: 'email', name: utms.utm_source || 'email' };
      }
      if (medium === 'social' || medium === 'social-media' || medium === 'paid_social' || medium === 'paidsocial') {
        return { type: 'social', name: utms.utm_source || 'unknown' };
      }
      if (medium === 'affiliate') {
        return { type: 'paid_affiliate', name: utms.utm_source || 'unknown' };
      }
      // Has UTM but unclassified medium — treat as campaign traffic
      if (utms.utm_source) {
        return { type: 'campaign', name: utms.utm_source };
      }
    }

    // 3. Referrer domain based
    if (referringDomain) {
      // Check AI search domains
      for (var aiDomain in AI_SEARCH_DOMAINS) {
        if (referringDomain === aiDomain || referringDomain.endsWith('.' + aiDomain)) {
          return { type: 'ai_search', name: AI_SEARCH_DOMAINS[aiDomain] };
        }
      }
      // Check search engines
      for (var seDomain in SEARCH_ENGINE_DOMAINS) {
        if (referringDomain === seDomain || referringDomain.endsWith('.' + seDomain)) {
          return { type: 'organic_search', name: SEARCH_ENGINE_DOMAINS[seDomain] };
        }
      }
      // Check social networks
      for (var socialDomain in SOCIAL_DOMAINS) {
        if (referringDomain === socialDomain) {
          return { type: 'social', name: SOCIAL_DOMAINS[socialDomain] };
        }
      }
      // Unknown referrer
      return { type: 'referral', name: referringDomain };
    }

    // 4. No referrer, no params
    return { type: 'direct', name: 'direct' };
  }

  // Persist first-touch traffic source
  function setFirstTouchTrafficSource(source) {
    if (!safeGet(localStorage, 'lr_ft_traffic_source_type') && source.type) {
      safeSet(localStorage, 'lr_ft_traffic_source_type', source.type);
      safeSet(localStorage, 'lr_ft_traffic_source_name', source.name);
    }
  }

  function getFirstTouchTrafficSource() {
    return {
      ft_traffic_source_type: safeGet(localStorage, 'lr_ft_traffic_source_type') || '',
      ft_traffic_source_name: safeGet(localStorage, 'lr_ft_traffic_source_name') || ''
    };
  }

  // ============================================================
  // BOT DETECTION
  // ============================================================

  function isBot() {
    if (BOT_PATTERN.test(navigator.userAgent)) return true;
    if (navigator.webdriver) return true;
    return false;
  }

  // ============================================================
  // PERFORMANCE METRICS
  // ============================================================

  function getPerformanceMetrics() {
    try {
      var entries = performance.getEntriesByType('navigation');
      if (!entries || !entries.length) return {};
      var nav = entries[0];
      return {
        page_load_time: Math.max(0, nav.loadEventEnd - nav.startTime),
        dom_content_loaded: Math.max(0, nav.domContentLoadedEventEnd - nav.startTime),
        dns_lookup_time: Math.max(0, nav.domainLookupEnd - nav.domainLookupStart),
        tcp_connection_time: Math.max(0, nav.connectEnd - nav.connectStart),
        ttfb: Math.max(0, nav.responseStart - nav.requestStart),
        dom_interactive: Math.max(0, nav.domInteractive - nav.startTime)
      };
    } catch (e) { logError('Failed to collect performance metrics', e); return {}; }
  }

  // ============================================================
  // TRANSPORT
  // ============================================================

  function transmit(json) {
    if (!ENCRYPTION_ENABLED) log('Wire payload is cleartext, ' + json.length + 'B');
    sendTo(COLLECT_ENDPOINT, json);
  }

  /**
   * Should a failed send be retried against the default endpoint?
   *
   * Only for a first-party endpoint, and only for the failures that mean "this
   * host is not serving the collector":
   *
   *   status 0    the request never completed — DNS, TLS, a refused CORS
   *               preflight, or a blocker cancelling it
   *   404 / 405   the host answered but nothing is routed to /web/ingest. 405
   *               is specifically the LB's branded-link handler, which is
   *               GET-only; it is what a customer host returns before the
   *               collector route ships.
   *
   * This is what makes an entry in FIRST_PARTY_ENDPOINTS safe to ship ahead of
   * the routing it depends on. Without it, adding a host whose /web/ingest is
   * not live yet takes that customer's events to zero.
   *
   * Deliberately NOT 400 or 5xx. Those come from our own backend, which both
   * hosts reach: 400 means it read the payload and rejected it, and the retry
   * would be rejected identically; 5xx means it may already have enqueued the
   * event, and retrying elsewhere would double-count it.
   */
  function shouldFallBack(endpoint, status) {
    if (endpoint === DEFAULT_ENDPOINT) return false;
    return status === 0 || status === 404 || status === 405;
  }

  function sendTo(endpoint, json) {
    /**
     * Priority 1: fetch with keepalive.
     *
     * sendBeacon used to be first. It was demoted on evidence, not taste:
     * measured on a live customer page with a mainstream blocker installed, a
     * beacon to our collector was cancelled while a fetch carrying the SAME
     * bytes to the SAME url in the same second went through and got a real
     * response. Filter lists can match the beacon/ping resource type
     * separately, and ours is matched. Every event sent by beacon on those
     * browsers was being dropped.
     *
     * The usual argument for beacon-first is surviving page unload. It does not
     * apply here: `keepalive` gives fetch the same guarantee, and this SDK has
     * no unload handler to begin with — events fire on page view and on
     * explicit track() calls, during normal page life.
     *
     * fetch also reports a status, which beacon cannot. That is what makes a
     * misconfigured first-party proxy visible instead of silent.
     */
    if (typeof fetch !== 'undefined') {
      try {
        log('Sending via fetch to ' + endpoint);
        fetch(endpoint, {
          method: 'POST',
          body: json,
          keepalive: true,
          headers: { 'Content-Type': 'application/json' }
        }).then(function(res) {
          if (res && !res.ok) {
            // An endpoint that answers, but answers wrong: a rewrite to a bad
            // path, a stale CORS policy, an auth rule in front of the
            // collector. Invisible without this line.
            logError('Endpoint returned HTTP ' + res.status + ' for ' + endpoint);
            if (shouldFallBack(endpoint, res.status)) {
              logError('Collector not routed on ' + endpoint + ', retrying on ' + DEFAULT_ENDPOINT);
              sendTo(DEFAULT_ENDPOINT, json);
            }
          } else {
            log('Sent via fetch');
          }
        }).catch(function(e) {
          // A blocked request lands here too, as a bare TypeError — the browser
          // deliberately does not say who cancelled it.
          logError('fetch request failed (blocked, offline, or CORS)', e);
          // Recurses at most one level: shouldFallBack is false once endpoint
          // IS the default, so the retry cannot itself retry.
          if (shouldFallBack(endpoint, 0)) {
            logError('Retrying on ' + DEFAULT_ENDPOINT);
            sendTo(DEFAULT_ENDPOINT, json);
          }
        });
      } catch (e) { logError('fetch call failed', e); }
      return;
    }

    // Priority 2: sendBeacon, for browsers without fetch.
    //
    // No first-party retry past this point. Beacon reports only whether the
    // browser queued the request and XHR's handlers are not wired up, so
    // neither can distinguish an unrouted host from a delivered event, and
    // retrying blind would double-count. Browsers without fetch predate every
    // blocker this feature is aimed at.
    if (navigator.sendBeacon) {
      try {
        var blob = new Blob([json], { type: 'application/json' });
        if (navigator.sendBeacon(endpoint, blob)) {
          log('Sent via sendBeacon');
          return;
        }
        log('sendBeacon returned false, falling back to XHR');
      } catch (e) { logError('sendBeacon failed', e); }
    }

    // Priority 3: XHR
    try {
      log('Sending via XHR');
      var xhr = new XMLHttpRequest();
      xhr.open('POST', endpoint, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(json);
    } catch (e) { logError('XHR send failed', e); }
  }

  // ============================================================
  // PAYLOAD ENCRYPTION
  // ============================================================

  function toBase64Url(buffer) {
    var bytes = new Uint8Array(buffer);
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromBase64Url(value) {
    var padded = value.replace(/-/g, '+').replace(/_/g, '/');
    while (padded.length % 4) padded += '=';
    var binary = atob(padded);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  /**
   * ECDH + HKDF, done once per page load rather than once per event.
   *
   * The expensive half — generating an ephemeral P-256 pair and deriving the
   * shared secret — is identical for every event in the page, so it is cached as
   * a promise. What is left per event is one AES-GCM encrypt, which is
   * microseconds. The first event still waits on this; that is the honest cost
   * of encryption, and it is why a visitor who bounces within a few hundred
   * milliseconds is likelier to be lost with encryption on than off.
   */
  var sealingContext = null;

  function getSealingContext() {
    if (sealingContext) return sealingContext;

    sealingContext = new Promise(function(resolve, reject) {
      var subtle = window.crypto && window.crypto.subtle;
      // Absent on http:// origins — subtle is secure-context only — and on
      // browsers old enough not to have it at all.
      if (!subtle) { reject(new Error('WebCrypto unavailable (needs a secure context)')); return; }

      var ephemeral;

      subtle.importKey('raw', fromBase64Url(ENCRYPTION_PUBLIC_KEY), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
        .then(function(serverKey) {
          return subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
            .then(function(pair) {
              ephemeral = pair;
              return subtle.deriveBits({ name: 'ECDH', public: serverKey }, pair.privateKey, 256);
            });
        })
        .then(function(shared) {
          return subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
        })
        .then(function(hkdfKey) {
          // The key id goes into `info`, so an envelope cannot be relabelled to
          // another key without derivation diverging and the tag check failing.
          return subtle.deriveBits({
            name: 'HKDF',
            hash: 'SHA-256',
            salt: new Uint8Array(0),
            info: new TextEncoder().encode(ENCRYPTION_INFO_PREFIX + ENCRYPTION_KEY_ID)
          }, hkdfKey, 256);
        })
        .then(function(aesBits) {
          return subtle.importKey('raw', aesBits, { name: 'AES-GCM' }, false, ['encrypt']);
        })
        .then(function(aesKey) {
          return subtle.exportKey('raw', ephemeral.publicKey).then(function(epk) {
            resolve({ aesKey: aesKey, epk: toBase64Url(epk) });
          });
        })
        .catch(reject);
    });

    return sealingContext;
  }

  function seal(json) {
    return getSealingContext().then(function(ctx) {
      var iv = window.crypto.getRandomValues(new Uint8Array(12));
      return window.crypto.subtle
        .encrypt({ name: 'AES-GCM', iv: iv }, ctx.aesKey, new TextEncoder().encode(json))
        .then(function(sealed) {
          // Field names are shared with the server's EncryptedEnvelope.
          return JSON.stringify({
            lrv: 1,
            kid: ENCRYPTION_KEY_ID,
            epk: ctx.epk,
            iv: toBase64Url(iv),
            ct: toBase64Url(sealed)
          });
        });
    });
  }

  function send(data) {
    var json = JSON.stringify(data);
    log('Sending ' + data.event_type + (data.event_name ? ':' + data.event_name : ''), data);

    if (!ENCRYPTION_ENABLED) { transmit(json); return; }

    seal(json).then(function(envelope) {
      // The line above logged the event; this logs what actually LEAVES the
      // browser. They are worth seeing side by side — the first is what you are
      // debugging, the second is all anything watching the network gets.
      log(
        'Sealed to key ' + ENCRYPTION_KEY_ID + ': ' + json.length + 'B -> ' + envelope.length + 'B on the wire',
        JSON.parse(envelope)
      );
      transmit(envelope);
    }).catch(function(e) {
      // Never lose an event to a crypto problem. The endpoint accepts both
      // shapes precisely so this fallback stays available.
      logError('Encryption failed, sending cleartext', e);
      transmit(json);
    });
  }

  // ============================================================
  // PAYLOAD BUILDER
  // ============================================================

  function buildPayload(eventType, eventName, eventData) {
    var utms = getPersistedUtms();
    var clickIds = getPersistedClickIds();
    var referringDomain = getReferringDomain(document.referrer);
    var trafficSource = classifyTrafficSource(clickIds, utms, referringDomain);
    setFirstTouchTrafficSource(trafficSource);

    // Increment session page count
    var count = parseInt(safeGet(sessionStorage, 'lr_spc') || '0', 10);
    if (eventType === 'page_view') {
      count++;
      safeSet(sessionStorage, 'lr_spc', count.toString());
    }

    // Set entry page on first page of session
    if (count <= 1 && eventType === 'page_view') {
      safeSet(sessionStorage, 'lr_entry', location.href);
    }

    var payload = {
      // Event
      token: TOKEN,
      event_id: generateUUID(),
      event_type: eventType,
      event_name: eventName || '',
      event_data: eventData ? JSON.stringify(eventData) : '',

      // Identity
      visitor_id: visitor.id,
      session_id: session.id,
      user_id: getUserId(),
      is_new_visitor: visitor.isNew ? 1 : 0,

      // Page
      page_url: location.href,
      page_path: location.pathname,
      page_title: document.title || '',
      page_hash: location.hash || '',
      page_search: location.search || '',
      document_referrer: document.referrer || '',
      referring_domain: referringDomain,
      canonical_url: getCanonicalUrl(),

      // Device
      screen_width: screen.width || 0,
      screen_height: screen.height || 0,
      screen_color_depth: screen.colorDepth || 0,
      viewport_width: window.innerWidth || 0,
      viewport_height: window.innerHeight || 0,
      device_pixel_ratio: window.devicePixelRatio || 1,
      language: navigator.language || '',
      languages: JSON.stringify(navigator.languages || []),
      platform: navigator.platform || '',
      timezone: (function() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch(e) { return ''; } })(),
      timezone_offset: new Date().getTimezoneOffset(),
      connection_type: (navigator.connection && navigator.connection.effectiveType) || '',
      cookies_enabled: navigator.cookieEnabled ? 1 : 0,
      do_not_track: navigator.doNotTrack || '',
      touch_support: navigator.maxTouchPoints || 0,
      hardware_concurrency: navigator.hardwareConcurrency || 0,
      device_memory: navigator.deviceMemory || 0,
      user_agent: navigator.userAgent || '',

      // Session
      session_page_count: count,
      entry_page: safeGet(sessionStorage, 'lr_entry') || location.href,

      // Traffic source
      traffic_source_type: trafficSource.type,
      traffic_source_name: trafficSource.name,

      // Bot
      is_bot: isBot() ? 1 : 0,

      // Timing
      client_timestamp: new Date().toISOString()
    };

    // Merge last-touch UTMs
    var utmKeys = Object.keys(utms);
    for (var i = 0; i < utmKeys.length; i++) {
      payload[utmKeys[i]] = utms[utmKeys[i]];
    }

    // Merge first-touch UTMs
    var ftUtms = getFirstTouchUtms();
    var ftUtmKeys = Object.keys(ftUtms);
    for (var j = 0; j < ftUtmKeys.length; j++) {
      payload[ftUtmKeys[j]] = ftUtms[ftUtmKeys[j]];
    }

    // Merge last-touch click IDs
    var cidKeys = Object.keys(clickIds);
    for (var k = 0; k < cidKeys.length; k++) {
      payload[cidKeys[k]] = clickIds[cidKeys[k]];
    }

    // Merge first-touch click IDs
    var ftClickIds = getFirstTouchClickIds();
    var ftCidKeys = Object.keys(ftClickIds);
    for (var l = 0; l < ftCidKeys.length; l++) {
      payload[ftCidKeys[l]] = ftClickIds[ftCidKeys[l]];
    }

    // Merge first-touch traffic source
    var ftTraffic = getFirstTouchTrafficSource();
    payload.ft_traffic_source_type = ftTraffic.ft_traffic_source_type;
    payload.ft_traffic_source_name = ftTraffic.ft_traffic_source_name;

    return payload;
  }

  // ============================================================
  // COLLECTORS
  // ============================================================

  var lastPageUrl = '';

  function collectPageView() {
    // Deduplicate — skip if URL hasn't changed (can happen with replaceState)
    var currentUrl = location.href;
    if (currentUrl === lastPageUrl) {
      log('Page view skipped (duplicate URL)', currentUrl);
      return;
    }
    lastPageUrl = currentUrl;
    log('Collecting page view', currentUrl);

    var payload = buildPayload('page_view', '', null);

    // Add performance metrics (only for page_view)
    var perf = getPerformanceMetrics();
    var perfKeys = Object.keys(perf);
    for (var i = 0; i < perfKeys.length; i++) {
      payload[perfKeys[i]] = perf[perfKeys[i]];
    }

    send(payload);
  }

  function trackCustomEvent(eventName, eventData) {
    log('track() called', { eventName: eventName, eventData: eventData });
    if (!eventName || typeof eventName !== 'string') {
      logError('track() ignored — eventName must be a non-empty string, got:', eventName);
      return;
    }
    var payload = buildPayload('custom', eventName, eventData || null);
    send(payload);
  }

  // ============================================================
  // SPA NAVIGATION HOOKS
  // ============================================================

  if (SPA_ENABLED) {
    var origPushState = history.pushState;
    history.pushState = function() {
      origPushState.apply(this, arguments);
      log('SPA navigation (pushState)');
      setTimeout(collectPageView, 100);
    };

    var origReplaceState = history.replaceState;
    history.replaceState = function() {
      origReplaceState.apply(this, arguments);
      log('SPA navigation (replaceState)');
      setTimeout(collectPageView, 100);
    };

    window.addEventListener('popstate', function() {
      log('SPA navigation (popstate)');
      setTimeout(collectPageView, 100);
    });
  }

  // ============================================================
  // PUBLIC API
  // ============================================================

  // Process any queued calls from the pre-init stub
  var existingQueue = (window.lr && window.lr._q) || [];

  // Mutate the existing object so npm import references stay valid
  if (!window.lr) window.lr = {};
  window.lr._q = [];
  window.lr.track = trackCustomEvent;
  window.lr.identify = function(userId) {
    setUserId(userId);
    var payload = buildPayload('identify', 'identify', null);
    send(payload);
  };
  window.lr._version = '0.1.14';

  // Replay queued events
  if (existingQueue.length) log('Replaying ' + existingQueue.length + ' queued event(s)');
  for (var qi = 0; qi < existingQueue.length; qi++) {
    try {
      var queued = existingQueue[qi];
      if (queued[0] === '__identify') {
        window.lr.identify(queued[1]);
      } else {
        trackCustomEvent.apply(null, queued);
      }
    } catch (e) { logError('Failed to replay queued event', e); }
  }

  // ============================================================
  // INITIALIZATION
  // ============================================================

  log('Initialized', { token: TOKEN.slice(0, 8) + '...', endpoint: COLLECT_ENDPOINT, spa: SPA_ENABLED });

  expireOldClickIds();
  persistParams();

  // After new visitor flag is read, clear it for subsequent events
  visitor.isNew = false;

  // Collect page view after load (for performance metrics accuracy)
  if (document.readyState === 'complete') {
    setTimeout(collectPageView, 0);
  } else {
    window.addEventListener('load', function() {
      setTimeout(collectPageView, 100);
    });
  }

})(window, document);
