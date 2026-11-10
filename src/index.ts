export interface Linkrunner {
  track: (eventName: string, eventData?: Record<string, any>) => void
  identify: (userId: string) => void
  /**
   * `baseUrl` (your Linkrunner link, e.g. `'https://link.your-app.com/'`) with the
   * visitor's last-touch ad click params added, for a web-to-app "Get the app" button.
   * Resolves to `baseUrl` unchanged when there is nothing to add.
   */
  getAppDownloadURL: (baseUrl: string) => Promise<string>
  _q: any[]
  _version: string
}

declare global {
  interface Window {
    lr: Linkrunner
    LinkrunnerConfig?: {
      token: string
      /**
       * Your own collection host — the subdomain you CNAME'd to
       * `api.linkrunner.io`, e.g. `'lr.your-domain.com'`. Events are posted to
       * it instead of our domain, which is what survives an ad blocker.
       *
       * A host, not a URL: the collector's path is ours and has moved before.
       */
      domain?: string
      /** A full URL or same-origin path. Only for a proxy you run yourself; otherwise use `domain`. */
      endpoint?: string
      spa?: boolean
      debug?: boolean
      /**
       * Your JioHotstar pixel id. When set, the SDK loads Hotstar's pixel and forwards
       * the events Hotstar supports (purchase, signup, …) from `lr.track`.
       */
      hotstarPixelId?: string
    }
  }
}

// The script resolves a queued getAppDownloadURL() when it loads. One that never loads (an
// ad blocker, a network error) must not leave the download button dead, so after this long
// the stub hands back the base URL unchanged.
const APP_DOWNLOAD_URL_FALLBACK_MS = 3000

function queueAppDownloadURL(queue: any[], baseUrl: string): Promise<string> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('getAppDownloadURL() runs in the browser only'))
  }
  return new Promise<string>((resolve, reject) => {
    queue.push(['__getAppDownloadURL', baseUrl, resolve, reject])
    setTimeout(() => resolve(baseUrl), APP_DOWNLOAD_URL_FALLBACK_MS)
  })
}

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
      getAppDownloadURL: function (baseUrl: string) {
        return queueAppDownloadURL(this._q, baseUrl)
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
    getAppDownloadURL: function (baseUrl: string) {
      return queueAppDownloadURL(this._q, baseUrl)
    },
  }

  return window.lr
}

export const lr = getOrCreateStub()
