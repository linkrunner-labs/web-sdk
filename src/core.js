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

  var COLLECT_ENDPOINT = configObj.endpoint
    || (scriptTag && scriptTag.getAttribute('data-endpoint'))
    || 'https://api.linkrunner.io/web/collect';

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

  // ============================================================
  // CONSTANTS
  // ============================================================

  var UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];

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
    console.error('[Linkrunner] ' + label, error);
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
  // UTM PERSISTENCE (sessionStorage for last-touch, localStorage for first-touch)
  // ============================================================

  function setFirstTouchUtm(key, value) {
    var ftKey = 'lr_ft_' + key;
    if (!safeGet(localStorage, ftKey) && value) {
      safeSet(localStorage, ftKey, value);
    }
  }

  function getFirstTouchUtm(key) {
    return safeGet(localStorage, 'lr_ft_' + key) || '';
  }

  // ============================================================
  // PARAMETER PERSISTENCE — extract from URL, persist to storage
  // ============================================================

  function persistParams() {
    var params = getQueryParams();
    var foundUtms = {};
    var foundClickIds = {};

    // UTMs → sessionStorage (last-touch, per session)
    for (var i = 0; i < UTM_KEYS.length; i++) {
      var key = UTM_KEYS[i];
      if (params[key]) {
        foundUtms[key] = params[key];
        safeSet(sessionStorage, 'lr_' + key, params[key]);
        setFirstTouchUtm(key, params[key]);
      }
    }

    // Click IDs → localStorage (last-touch with TTL)
    for (var j = 0; j < CLICK_ID_KEYS.length; j++) {
      var cidKey = CLICK_ID_KEYS[j];
      if (params[cidKey]) {
        foundClickIds[cidKey] = params[cidKey];
        setClickId(cidKey, params[cidKey]);
        setFirstTouchClickId(cidKey, params[cidKey]);
      }
    }

    if (Object.keys(foundUtms).length) log('UTM params found', foundUtms);
    if (Object.keys(foundClickIds).length) log('Click IDs found', foundClickIds);
  }

  function getPersistedUtms() {
    var utms = {};
    for (var i = 0; i < UTM_KEYS.length; i++) {
      var key = UTM_KEYS[i];
      utms[key] = safeGet(sessionStorage, 'lr_' + key) || '';
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

  function send(data) {
    var json = JSON.stringify(data);
    log('Sending ' + data.event_type + (data.event_name ? ':' + data.event_name : ''), data);

    // Priority 1: sendBeacon
    if (navigator.sendBeacon) {
      try {
        var blob = new Blob([json], { type: 'application/json' });
        if (navigator.sendBeacon(COLLECT_ENDPOINT, blob)) {
          log('Sent via sendBeacon');
          return;
        }
        log('sendBeacon returned false, falling back to fetch');
      } catch (e) { logError('sendBeacon failed', e); }
    }

    // Priority 2: fetch with keepalive
    if (typeof fetch !== 'undefined') {
      try {
        log('Sending via fetch');
        fetch(COLLECT_ENDPOINT, {
          method: 'POST',
          body: json,
          keepalive: true,
          headers: { 'Content-Type': 'application/json' }
        }).catch(function(e) { logError('fetch request failed', e); });
      } catch (e) { logError('fetch call failed', e); }
      return;
    }

    // Priority 3: XHR
    try {
      log('Sending via XHR');
      var xhr = new XMLHttpRequest();
      xhr.open('POST', COLLECT_ENDPOINT, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(json);
    } catch (e) { logError('XHR send failed', e); }
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

  window.lr = {
    _q: [],
    track: trackCustomEvent,
    identify: function(userId) { setUserId(userId); },
    _version: '0.1.6'
  };

  // Replay queued events
  if (existingQueue.length) log('Replaying ' + existingQueue.length + ' queued event(s)');
  for (var qi = 0; qi < existingQueue.length; qi++) {
    try {
      trackCustomEvent.apply(null, existingQueue[qi]);
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
