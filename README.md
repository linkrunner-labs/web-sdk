# @linkrunner/web

Web attribution SDK for [Linkrunner](https://linkrunner.io) — track page views, custom events, and traffic sources with first-touch and last-touch attribution.

## Features

- Automatic page view tracking (including SPA navigation)
- First-touch and last-touch UTM attribution
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

## Custom events

```js
import { lr } from '@linkrunner/web'
lr.track('event_name', { key: 'value' })

// or: window.lr.track('event_name', { key: 'value' })
```

Events can be queued before the script loads — they'll be replayed automatically once initialized.

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
