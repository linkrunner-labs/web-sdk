'use client'

import Script from 'next/script.js'

interface LinkrunnerScriptProps {
  token: string
  endpoint?: string
  spa?: boolean
  debug?: boolean
}

export function LinkrunnerScript({ token, endpoint, spa, debug }: LinkrunnerScriptProps) {
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
      strategy="afterInteractive"
      {...dataAttrs}
    />
  )
}
