'use client'

import Script from 'next/script.js'

/** Where the SDK is served from when the host app does not proxy it itself. */
const CDN_SCRIPT_SRC = 'https://cdn.linkrunner.io/web/v1/lr.js'

interface LinkrunnerScriptProps {
  token: string
  /**
   * Your own collection host — the subdomain you CNAME'd to
   * `api.linkrunner.io`, e.g. `'lr.your-domain.com'`.
   *
   * This is what survives an ad blocker: blocklists match the request's
   * DOMAIN, not only its path, so no path we pick can outrun a rule written
   * against ours. Posting from a host on your own site has no rule to match.
   *
   * A host, not a URL — the collector's path is ours to choose and has moved
   * before, and naming only the host means you follow it automatically.
   */
  domain?: string
  /**
   * Where events are posted, as a full URL or a same-origin path. Defaults to
   * our API, and overrides `domain` when both are set.
   *
   * Reach for this only when you proxy collection through your own origin —
   * `'/lr/ingest'` — where there is no host to name. If you delegated a
   * subdomain to us, set `domain` instead: it needs no path, so it keeps
   * working when ours changes.
   */
  endpoint?: string
  /**
   * Where the SDK itself is served from. Defaults to our CDN.
   *
   * Proxy this through your own origin too — `'/lr/lr.js'` — if you are
   * proxying `endpoint`. A blocked script never runs, so an endpoint on your
   * domain fed by a script on ours only moves the failure one step earlier.
   */
  scriptSrc?: string
  spa?: boolean
  debug?: boolean
}

export function LinkrunnerScript({
  token,
  domain,
  endpoint,
  scriptSrc = CDN_SCRIPT_SRC,
  spa,
  debug,
}: LinkrunnerScriptProps) {
  const dataAttrs: Record<string, string> = {
    'data-token': token,
  }

  if (domain) {
    dataAttrs['data-domain'] = domain
  }

  if (endpoint) {
    dataAttrs['data-endpoint'] = endpoint
  }

  if (spa === false) {
    dataAttrs['data-spa'] = 'false'
  }

  if (debug === true) {
    dataAttrs['data-debug'] = 'true'
  } else if (debug === false) {
    dataAttrs['data-debug'] = 'false'
  }

  return (
    <Script
      src={scriptSrc}
      strategy="afterInteractive"
      {...dataAttrs}
    />
  )
}
