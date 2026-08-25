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
    }
  }
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
