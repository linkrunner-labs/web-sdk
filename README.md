# @linkrunner/web

Web attribution SDK for [Linkrunner](https://linkrunner.io) — track page views, custom events, and traffic sources with first-touch and last-touch attribution.

## Features

- Automatic page view tracking (including SPA navigation)
- First-touch and last-touch UTM attribution
- Last-touch UTMs survive payment gateway redirects and tab loss for 24 hours
- Click ID persistence (gclid, fbclid, ttclid, etc.) with 90-day TTL
- Traffic source classification (paid, organic, social, AI search, referral, direct)
- AI search engine detection (ChatGPT, Perplexity, Claude, Gemini, and more)
- Bot detection
- Performance metrics collection
- Lightweight (~10KB minified), zero dependencies
- Works with any framework or plain HTML

## Installation

```bash
npm install @linkrunner/web
```

## Usage

### Script tag (any website)

Add the script to your HTML with your project token:

```html
<script
  src="https://cdn.linkrunner.io/web/v1/lr.js"
  data-token="YOUR_PROJECT_TOKEN"
  defer
></script>
```

### Next.js (App Router)

Place `LinkrunnerScript` in your root `layout.tsx` so it loads once and persists across all navigations:

```tsx
// app/layout.tsx
import { LinkrunnerScript } from '@linkrunner/web/next'

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        {children}
        <LinkrunnerScript token="YOUR_PROJECT_TOKEN" />
      </body>
    </html>
  )
}
```

### Next.js (Pages Router)

Place `LinkrunnerScript` in `_app.tsx` — not in `_document.tsx` or individual pages:

```tsx
// pages/_app.tsx
import { LinkrunnerScript } from '@linkrunner/web/next'

export default function App({ Component, pageProps }) {
  return (
    <>
      <LinkrunnerScript token="YOUR_PROJECT_TOKEN" />
      <Component {...pageProps} />
    </>
  )
}
```

### Custom events

Fire custom events from anywhere in your app using either approach:

```js
// Via the npm import
import { lr } from '@linkrunner/web'
lr.track('purchase', { amount: 49.99, currency: 'USD' })

// Or via the global object
window.lr.track('signup', { plan: 'pro' })
```

Events can be queued before the script loads — they'll be replayed automatically once initialized.

## Configuration

### Script tag attributes

| Attribute       | Required | Description                                          | Default                                |
| --------------- | -------- | ---------------------------------------------------- | -------------------------------------- |
| `data-token`    | Yes      | Your Linkrunner project token                        | —                                      |
| `data-endpoint` | No       | Where events are posted. See [First-party collection](#first-party-collection-recommended) | `https://api.linkrunner.io/web/ingest` |
| `data-spa`      | No       | Set to `"false"` to disable SPA mode                 | `true`                                 |
| `data-debug`    | No       | `"true"` / `"false"` to force debug mode             | Auto                                   |

### JavaScript config object

You can also configure via `window.LinkrunnerConfig` before the script loads:

```html
<script>
  window.LinkrunnerConfig = {
    token: 'YOUR_PROJECT_TOKEN',
    spa: true,  // optional, default true
    debug: true // optional, auto-detected on localhost
  }
</script>
<script src="https://cdn.linkrunner.io/web/v1/lr.js" defer></script>
```

## First-party collection (recommended)

By default the SDK loads from `cdn.linkrunner.io` and posts to `api.linkrunner.io`.
Both are third-party requests, and ad blockers match requests by **domain**, not
just by path — so no endpoint name we choose can outrun a blocklist rule written
against our domain. Roughly a quarter of desktop users run one.

Serving both through **your own domain** makes them first-party. There is nothing
left for a domain rule to match, and the beacon is same-origin, so it also stops
issuing a CORS preflight.

This is measured, not assumed. On a live customer page with a mainstream blocker
installed, an event sent to `api.linkrunner.io` was cancelled, while the same
bytes sent to a subdomain of the site's own domain — CNAME'd to that very same
server — went through and got a real response. The blocker matches the hostname
the browser sees, and nothing else. Encrypting the payload changed nothing in
either direction, because the request is cancelled before a body is ever sent.

### Option 1: proxy through your own origin (strongest)

You need two routes on your origin:

| Your path     | Proxies to                             | Why                       |
| ------------- | -------------------------------------- | ------------------------- |
| `/lr/lr.js`   | `https://cdn.linkrunner.io/web/v1/lr.js` | The SDK itself            |
| `/lr/ingest`  | `https://api.linkrunner.io/web/ingest` | Where events are posted   |

**Pick your own path.** `/lr/` is an example, not a requirement. A path every
customer shares is a pattern someone can write one filter rule against; a path
unique to your site is not. Anything that does not read as analytics works —
`/api/metrics-relay`, `/s/e`, whatever fits your app.

### Next.js

```js
// next.config.js
module.exports = {
  async rewrites() {
    return [
      { source: '/lr/lr.js', destination: 'https://cdn.linkrunner.io/web/v1/lr.js' },
      { source: '/lr/ingest', destination: 'https://api.linkrunner.io/web/ingest' },
    ]
  },
}
```

```tsx
<LinkrunnerScript
  token="YOUR_PROJECT_TOKEN"
  scriptSrc="/lr/lr.js"
  endpoint="/lr/ingest"
/>
```

### Plain script tag

```html
<script src="/lr/lr.js" data-token="YOUR_PROJECT_TOKEN" data-endpoint="/lr/ingest"></script>
```

### nginx

```nginx
location /lr/ingest {
    proxy_pass https://api.linkrunner.io/web/ingest;
    proxy_set_header Host api.linkrunner.io;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}

location /lr/lr.js {
    proxy_pass https://cdn.linkrunner.io/web/v1/lr.js;
    proxy_set_header Host cdn.linkrunner.io;
}
```

### Cloudflare Workers

A Worker's `fetch()` builds fresh headers, so the visitor's address has to be
passed on explicitly:

```js
export default {
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname !== '/lr/ingest') return fetch(request)

    return fetch('https://api.linkrunner.io/web/ingest', {
      method: 'POST',
      body: request.body,
      headers: {
        'Content-Type': 'application/json',
        'X-Linkrunner-Visitor-IP': request.headers.get('CF-Connecting-IP'),
      },
    })
  },
}
```

### Option 2: a subdomain pointed at us (no proxy to run)

If you would rather not run a proxy, delegate a subdomain instead. Add it under
**Settings → Manage Domains** in the dashboard, then point it at us:

```
lr.your-domain.com.  CNAME  api.linkrunner.io.
```

We issue the certificate automatically on first request — only for subdomains
registered against your project — and serve both routes from it.

**Change one attribute.** Point `src` at your subdomain and the endpoint follows
it automatically: we serve the collector from the same host, so there is nothing
to keep in sync and no way to move the script first-party while leaving the
beacon behind.

```html
<script
  src="https://lr.your-domain.com/web/v1/lr.js"
  data-token="YOUR_PROJECT_TOKEN"
></script>
```

For Next.js, the same single change:

```tsx
<LinkrunnerScript token="YOUR_PROJECT_TOKEN" scriptSrc="https://lr.your-domain.com/web/v1/lr.js" />
```

`data-endpoint` still overrides it if you want the two split.

Nothing to deploy, nothing to keep working, and the visitor's IP arrives exactly
right because there is no proxy of yours in the path to lose it.

The trade-off is real, though. The CNAME resolves to `api.linkrunner.io`, and
uBlock Origin on Firefox — and Brave — follow the chain and apply their filters
to what they find at the end of it. On those browsers this is worth no more than
posting to us directly. Chrome extensions have no DNS API and cannot do it, so
this still covers most traffic — but **Option 1 covers all of it**, because a
same-origin path has nothing to uncloak. Pick Option 2 when you cannot ship a
rewrite, not when you can.

### Preserving the visitor's IP (Option 1)

This is the one thing worth getting right, because getting it wrong fails
silently. We derive geo from the address the request arrives with. If your proxy
drops the visitor's address, every one of your visitors arrives as your CDN, and
the data will look plausible while being wrong.

Either is fine:

- forward `X-Forwarded-For` with the visitor's address first — the nginx block
  above does this, and most managed platforms do it for you, or
- set `X-Linkrunner-Visitor-IP` to the visitor's address explicitly, which is
  worth doing whenever you are not certain of the first.

Private addresses in the chain are skipped, so an internal hop in front of your
proxy does no harm.

Check it once after setup rather than assuming: compare the country on a handful
of new web events against where you actually are. Everything landing in one place
means the address is being lost.

### Verifying the setup

Load a page with `data-debug="true"` and watch the console. The SDK posts via
`fetch`, which reports a status — a misdirected rewrite shows up as
`Endpoint returned HTTP 404`. A working install logs `Sent via fetch`.

### What this does not fix

First-party is the strongest available client-side answer, not an absolute one.
Filter lists can still add rules against a specific first-party path, which is
why the path should be yours rather than ours. Safari's ITP still caps
script-writable storage regardless of who serves it. For conversions that must
not be lost — payments, signups — send them server-to-server from your backend,
where no blocker participates at all.

## Payload encryption (optional)

Events can be sealed in the browser so only Linkrunner can read them.

**Read this first: it does nothing about ad blockers.** Blockers cancel the
request in `onBeforeRequest`, from the URL alone — there is never a body for
them to read, encrypted or not. If you are here to avoid being blocked, the
answer is [first-party collection](#first-party-collection-recommended); this is
a different feature solving a different problem.

What it does buy: the payload names page URLs, referrers, a visitor id and
whatever you attach as `event_data`. TLS protects that from the network, but TLS
terminates at every hop holding a certificate — your own reverse proxy in the
first-party setup above, a corporate MITM appliance on a visitor's network, any
CDN in between. Sealing to a key only we hold closes the gap, and keeps the event
schema off the wire.

What it does not buy: authentication. The SDK holds only a public key, so anyone
can produce a valid envelope. That is not a regression — your project token is
already visible in your page source — but a decrypted payload is not a trusted
one.

### Turning it on

Nothing to configure: the key ships in the bundle, and a bundle without one sends
cleartext exactly as before. Ask us to issue you a keyed build. Both shapes are
accepted on the endpoint permanently, so cached older bundles keep reporting
throughout and it is safe to roll back.

### What it costs

- **~1.8 KB** more minified SDK.
- **One ECDH per page load**, not per event — the expensive half is derived once
  and cached, leaving one AES-GCM encrypt per event.
- **The first event waits on that derivation.** A visitor who bounces within a
  few hundred milliseconds is likelier to be lost with encryption on than off.
- **Payloads grow by about 40%**, from base64. A real 3.2 KB page view seals to
  4.4 KB — well inside the collector's 64 KB ceiling.
- **Nothing readable in devtools.** Your own network tab shows an opaque
  envelope, which is a real cost when debugging an integration.

If any of those matter more to you than the payload being unreadable in transit,
leave it off. It is off by default for that reason.

### How it works

ECIES over P-256 — an ephemeral key pair per page load, ECDH against our public
key, HKDF-SHA256 to an AES-256-GCM key, fresh IV per event. The key id is bound
into the HKDF `info`, so an envelope cannot be relabelled to a different key. If
WebCrypto is unavailable — an `http://` origin, since `crypto.subtle` is
secure-context only — the SDK sends cleartext rather than dropping the event.

## Testing locally

### Console logging

Load any page with `data-debug="true"` and the SDK reports both halves of every
event — what you are debugging, then what actually leaves the browser:

```
[Linkrunner] Sending page_view {token: "...", event_type: "page_view", ...}
[Linkrunner] Sealed to key k1: 1922B -> 2736B on the wire {lrv: 1, kid: "k1", epk: "BAar...", iv: "uBv-...", ct: "nlmG..."}
```

With encryption off it states the wire size instead, so the two are directly
comparable:

```
[Linkrunner] Wire payload is cleartext, 1921B
```

### Running your local SDK on a real website

To replace the CDN bundle on a site you do not control, use Chrome DevTools
**Local Overrides**:

1. DevTools → **Sources** → **Overrides** → *Select folder for overrides*, and
   allow access.
2. Load the site once so `cdn.linkrunner.io/web/v1/lr.js` appears in **Network**.
3. Right-click that request → **Override content**.
4. Replace the file's contents with your `src/core.js`. Change the default
   endpoint near the top of the file to `http://localhost:8787/web/ingest` if you
   want the events to land in the dev collector — the page's own script tag will
   otherwise keep pointing at production.
5. Reload. The override persists across reloads until you turn it off.

### Pasting into the console

This works, with two things to get right:

```js
// 1. Set the config FIRST — core.js reads it the moment it executes.
window.LinkrunnerConfig = {
  token: 'dev_token',
  endpoint: 'http://localhost:8787/web/ingest',
  spa: false,
  debug: true,
}
// 2. Then paste the entire contents of src/core.js and hit enter.
```

Caveats worth knowing before you conclude something is broken:

- **The site's CSP can block the beacon.** `connect-src` applies to your pasted
  code just as it does to the page's own, and a strict policy will refuse a POST
  to localhost. The console will say so. Test on the dev collector's page or a
  site you control.
- **Re-pasting on the same page double-fires.** `window.lr` already exists and
  the script re-initialises. Reload between runs.
- **`document.currentScript` is null in the console**, so `data-*` attributes are
  not available — configure through `window.LinkrunnerConfig`, as above.

## Debugging

The SDK includes built-in debug logging that helps you understand what's happening under the hood.

### Auto-detection

Debug mode **turns on automatically** when your site runs on `localhost`, `127.0.0.1`, or `[::1]`. No configuration needed — just open your browser console during development.

### Manual override

Force debug mode on or off regardless of hostname:

```html
<!-- Script tag -->
<script src="https://cdn.linkrunner.io/web/v1/lr.js" data-token="YOUR_TOKEN" data-debug="true"></script>
```

```js
// Config object
window.LinkrunnerConfig = { token: 'YOUR_TOKEN', debug: true }
```

```tsx
// Next.js
<LinkrunnerScript token="YOUR_TOKEN" debug={true} />
```

Setting `debug` to `false` disables logging even on localhost.

### What gets logged

All logs are prefixed with `[Linkrunner]` in the console:

- **Initialization** — token, endpoint, SPA mode
- **Identity** — visitor ID, session ID, new visitor detection
- **URL params** — UTMs and click IDs extracted from the current URL
- **Page views** — URL being tracked, SPA navigation events
- **Custom events** — event name and data passed to `lr.track()`
- **Payloads** — full request body sent to the collection endpoint
- **Transport** — which method was used (fetch, then sendBeacon, then XHR)
- **Errors** — any caught errors are logged via `console.error`

## User identification

Associate events with a known user by calling `identify` with your internal user ID:

```js
import { lr } from '@linkrunner/web'
lr.identify('user_123')

// or: window.lr.identify('user_123')
```

Call `identify` once the user logs in or is otherwise known. The user ID is persisted in `localStorage` and included in all subsequent events as `user_id`.

### Track a signup with identity traits

To show a signed-up user's name, email address, and phone number in the **Users** table in the Linkrunner Web Events dashboard, identify the user and then track their signup. `identify` associates the events with your internal user ID; the `signup` event carries the identity traits.

```js
import { lr } from '@linkrunner/web'

lr.identify(String(user.id)) // Use a stable, non-PII internal ID

lr.track('signup', {
  name: user.name,
  email: user.email,
  phone: user.phone,
})
```

Call these after the signup succeeds. You can provide `first_name` and `last_name` instead of `name`:

```js
lr.track('signup', {
  first_name: user.firstName,
  last_name: user.lastName,
  email: user.email,
  phone: user.phone,
})
```

Only send identity traits when you have the appropriate permission to do so. Previously captured anonymous events are not backfilled.

## Custom events

```js
import { lr } from '@linkrunner/web'
lr.track('event_name', { key: 'value' })

// or: window.lr.track('event_name', { key: 'value' })
```

Events can be queued before the script loads — they'll be replayed automatically once initialized.

## Attribution storage

| What                                                              | Where                                   | Lifetime                     |
| ----------------------------------------------------------------- | --------------------------------------- | ---------------------------- |
| First-touch UTMs and click IDs (`ft_*`)                            | `localStorage`                          | Until storage is cleared     |
| Last-touch click IDs (`gclid`, `fbclid`, …)                        | `localStorage`                          | 90 days                      |
| Last-touch UTMs (`utm_source`, `utm_campaign`, `utm_id`, …)        | `sessionStorage` + `localStorage` (`lr_lt`) | 24 hours from the campaign click |
| Visitor ID, user ID                                                | `localStorage`                          | Until storage is cleared     |
| Session ID, session page count, entry page                         | `sessionStorage`                        | Tab session                  |

Last-touch UTMs are mirrored into `localStorage` because `sessionStorage` is per tab.
A payment gateway (or a bank 3DS page) that returns the visitor in a fresh tab would
otherwise drop every `utm_*` value, so the purchase arrives with no campaign attached
even though the click IDs still identify the network. The mirrored copy is replaced
whenever a URL carries new UTMs, dropped when a URL carries a new click ID with no UTMs,
and expires 24 hours after the campaign click. First-touch values are never affected.

Two consequences of the `localStorage` mirror worth knowing:

**Last-touch UTMs are device-scoped, not tab-scoped.** `localStorage` is shared across
tabs while `sessionStorage` is not, so when a visitor opens two campaigns in two tabs,
both tabs report the most recent one. This matches how last-touch click IDs already
behave (they have always been device-scoped with a 90-day lifetime), so the campaign and
the traffic source now agree instead of disagreeing per tab.

**A tab left open longer than 24 hours loses its UTMs.** Expiry clears the
`sessionStorage` mirror too, so the window means the same thing whether or not the tab
survived. This is deliberate — a campaign should not take credit for a visit a day later
— but it is narrower than the previous behaviour, where a `sessionStorage` value lived
as long as the tab did. Click IDs are unaffected, so the traffic source still resolves.

## Traffic source detection

The SDK automatically classifies traffic into these source types:

| Type             | Detected via                                     |
| ---------------- | ------------------------------------------------ |
| `paid_search`    | gclid, gbraid, wbraid, msclkid, or UTM medium   |
| `paid_social`    | fbclid, ttclid, twclid, li_fat_id, or UTM medium |
| `paid_display`   | dclid or UTM medium                              |
| `paid_affiliate` | irclickid or UTM medium                          |
| `ai_search`      | Referrer from ChatGPT, Perplexity, Claude, etc.  |
| `organic_search` | Referrer from Google, Bing, DuckDuckGo, etc.     |
| `social`         | Referrer from Facebook, Twitter, Reddit, etc.    |
| `email`          | UTM medium                                       |
| `campaign`       | UTM parameters present                           |
| `referral`       | External referrer domain                         |
| `direct`         | No referrer or parameters                        |

## License

[MIT](./LICENSE)
