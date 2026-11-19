export async function relayConfigHandler(
  event: any,
  env: Record<string, string | undefined> = process.env
) {
  if (event.httpMethod && event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ configured: false, wssUrl: null, error: 'Método no permitido. Utilizar GET.' })
    };
  }

  const cleanEnvValue = (val?: string) =>
    String(val || '')
      .trim()
      .replace(/^["']|["']$/g, '')
      .trim();

  const rawServerUrl = cleanEnvValue(env.VEL_RELAY_WSS_URL);
  const rawViteUrl = cleanEnvValue(env.VITE_VEL_RELAY_WSS_URL);

  const resolved = rawServerUrl || rawViteUrl;
  const isValidWsUrl = /^wss?:\/\/.+/i.test(resolved);

  if (!isValidWsUrl) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        configured: false,
        wssUrl: null,
        source: 'none',
        message:
          'Relay WebSocket pendiente de despliegue y configuración (definir VEL_RELAY_WSS_URL en Netlify como variable de entorno de ejecución).'
      })
    };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({
      configured: true,
      wssUrl: resolved.replace(/\/+$/, ''),
      source: rawServerUrl ? 'env' : 'vite_env'
    })
  };
}

export const handler = async (event: any) => {
  return relayConfigHandler(event);
};
