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
    }
  }
}

function getOrCreateStub(): Linkrunner {
  if (typeof window === 'undefined') {
    return {
      _q: [],
      _version: '0.1.2',
      track: function (...args: any[]) {
        this._q.push(args)
      },
      identify: function () {},
    }
  }

  if (window.lr && typeof window.lr.track === 'function') {
    return window.lr
  }

  window.lr = window.lr || {
    _q: [],
    _version: '0.1.2',
    track: function (...args: any[]) {
      this._q.push(args)
    },
    identify: function () {},
  }

  return window.lr
}

export const lr = getOrCreateStub()
