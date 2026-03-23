'use client'

import Script from 'next/script.js'

interface LinkrunnerScriptProps {
  token: string
  endpoint?: string
  spa?: boolean
}

export function LinkrunnerScript({ token, endpoint, spa }: LinkrunnerScriptProps) {
  const dataAttrs: Record<string, string> = {
    'data-token': token,
  }

  if (endpoint) {
    dataAttrs['data-endpoint'] = endpoint
  }

  if (spa === false) {
    dataAttrs['data-spa'] = 'false'
  }

  return (
    <Script
      src="https://cdn.linkrunner.io/web/v1/lr.js"
      strategy="afterInteractive"
      {...dataAttrs}
    />
  )
}
