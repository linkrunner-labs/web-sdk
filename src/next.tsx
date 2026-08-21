'use client'

import Script from 'next/script.js'

/** Where the SDK is served from when the host app does not proxy it itself. */
const CDN_SCRIPT_SRC = 'https://cdn.linkrunner.io/web/v1/lr.js'

interface LinkrunnerScriptProps {
  token: string
  /**
   * Where events are posted. Defaults to our API.
   *
   * Set this to a path on your own domain — `'/lr/ingest'` — when you proxy
   * collection through your own origin. That is what makes the request
   * first-party, and first-party is what survives an ad blocker: blocklists
   * match the request's DOMAIN, not only its path, so no path we pick can
   * outrun a rule written against ours.
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
  endpoint,
  scriptSrc = CDN_SCRIPT_SRC,
  spa,
  debug,
}: LinkrunnerScriptProps) {
  const dataAttrs: Record<string, string> = {
    'data-token': token,
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
