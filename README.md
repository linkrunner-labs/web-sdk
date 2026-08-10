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

| Attribute    | Required | Description                             | Default |
| ------------ | -------- | --------------------------------------- | ------- |
| `data-token` | Yes      | Your Linkrunner project token           | —       |
| `data-spa`   | No       | Set to `"false"` to disable SPA mode    | `true`  |
| `data-debug` | No       | `"true"` / `"false"` to force debug mode | Auto    |

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
- **Transport** — which method was used (sendBeacon, fetch, or XHR)
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
