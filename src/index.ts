export interface Linkrunner {
  track: (eventName: string, eventData?: Record<string, any>) => void
  identify: (userId: string) => void
  _q: any[]
  _version: string
}

declare global {
  interface Window {
    lr: Linkrunner
    LinkrunnerConfig?: {
      token: string
      endpoint?: string
      spa?: boolean
      debug?: boolean
    }
  }
}

/**
 * Key under which the landing snapshot is stored. Shared with `core.js`, which
 * reads it back — change one and you must change the other.
 */
const LANDING_SNAPSHOT_KEY = 'lr_snap'

/**
 * Record the URL and referrer the visitor actually arrived on, synchronously, at
 * module-evaluation time.
 *
 * The SDK script reads `location.search` exactly once, when it executes. Loaded
 * the usual way (Next.js `strategy="afterInteractive"`, or any async tag) it
 * executes AFTER hydration, and on a slow in-app browser the visitor has often
 * already tapped through to a second page by then — where there is no query
 * string, so the campaign is lost for the whole visit with no second chance.
 * Measured on Meta's in-app browser, time-to-interactive was 742ms against 316ms
 * on the visits we did capture.
 *
 * This module is imported by the app bundle, so it evaluates before hydration
 * completes and well before an `afterInteractive` tag runs. Taking the snapshot
 * here means `core.js` can recover the landing parameters however late it loads.
 *
 * First write wins: a client-side route change must never overwrite the landing
 * record. Everything is wrapped because Safari private mode throws on
 * sessionStorage access.
 */
function snapshotLandingUrl(): void {
  if (typeof window === 'undefined') return

  try {
    if (window.sessionStorage.getItem(LANDING_SNAPSHOT_KEY)) return

    window.sessionStorage.setItem(
      LANDING_SNAPSHOT_KEY,
      JSON.stringify({
        href: window.location.href,
        search: window.location.search,
        referrer: window.document.referrer,
      })
    )
  } catch {
    // Storage unavailable — core.js falls back to reading the live URL.
  }
}

// Runs on import, before anything else in this module.
snapshotLandingUrl()

function getOrCreateStub(): Linkrunner {
  if (typeof window === 'undefined') {
    return {
      _q: [],
      _version: '0.1.9',
      track: function (...args: any[]) {
        this._q.push(args)
      },
      identify: function (userId: string) {
        this._q.push(['__identify', userId])
      },
    }
  }

  if (window.lr && typeof window.lr.track === 'function') {
    return window.lr
  }

  window.lr = window.lr || {
    _q: [],
    _version: '0.1.9',
    track: function (...args: any[]) {
      this._q.push(args)
    },
    identify: function (userId: string) {
        this._q.push(['__identify', userId])
      },
  }

  return window.lr
}

export const lr = getOrCreateStub()
