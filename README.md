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

### Next.js

```tsx
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

### NPM import (any JS framework)

```js
import { lr } from '@linkrunner/web'

// Track custom events
lr.track('signup', { plan: 'pro' })
lr.track('purchase', { amount: 49.99, currency: 'USD' })
```

## Configuration

### Script tag attributes

| Attribute       | Required | Description                          | Default                                        |
| --------------- | -------- | ------------------------------------ | ---------------------------------------------- |
| `data-token`    | Yes      | Your Linkrunner project token        | —                                              |
| `data-endpoint` | No       | Custom collection endpoint           | `https://collect.linkrunner.io/api/web/collect` |
| `data-spa`      | No       | Set to `"false"` to disable SPA mode | `true`                                         |

### JavaScript config object

You can also configure via `window.LinkrunnerConfig` before the script loads:

```html
<script>
  window.LinkrunnerConfig = {
    token: 'YOUR_PROJECT_TOKEN',
    endpoint: 'https://your-custom-endpoint.com/collect', // optional
    spa: true // optional, default true
  }
</script>
<script src="https://cdn.linkrunner.io/web/v1/lr.js" defer></script>
```

## Custom events

```js
// Via the global lr object (script tag)
window.lr.track('event_name', { key: 'value' })

// Via the npm import
import { lr } from '@linkrunner/web'
lr.track('event_name', { key: 'value' })
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
