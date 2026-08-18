'use client'

import Script from 'next/script.js'

interface LinkrunnerScriptProps {
  token: string
  endpoint?: string
  spa?: boolean
  debug?: boolean
  /**
   * When Next.js executes the script.
   *
   * The SDK reads the URL the moment it runs, so this decides whether it sees
   * the ad's click ID at all. `afterInteractive` (the default, kept for
   * backwards compatibility) runs AFTER hydration — if your app rewrites its own
   * URL during hydration, stripping utm/click parameters, they are already gone.
   *
   * Measured on production, that costs roughly 30% of click IDs on Meta in-app
   * browsers, where time-to-interactive is more than twice as long as on a normal
   * browser.
   *
   * Prefer `beforeInteractive` — it runs before hydration and captures the
   * original URL. Next.js only permits it in the root layout (App Router) or
   * `_document` (Pages Router).
   */
  strategy?: 'beforeInteractive' | 'afterInteractive' | 'lazyOnload'
}

export function LinkrunnerScript({
  token,
  endpoint,
  spa,
  debug,
  strategy = 'afterInteractive',
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
      src="https://cdn.linkrunner.io/web/v1/lr.js"
      strategy={strategy}
      {...dataAttrs}
    />
  )
}
