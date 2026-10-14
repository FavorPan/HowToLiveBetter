// worker/src/util.mjs
const CORS_ORIGINS = ['https://howtolivebetter.favorhub.top', 'https://favorpan.github.io'];

export function pickOrigin(request) {
  const o = request.headers.get('origin');
  if (!o) return null;
  if (CORS_ORIGINS.includes(o)) return o;
  try {
    const h = new URL(o).hostname;
    if (h === '127.0.0.1' || h === 'localhost') return o; // 本地开发
  } catch { /* ignore */ }
  return null;
}

export function json(data, status = 200, origin = null) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  };
  if (origin) {
    headers['access-control-allow-origin'] = origin;
    headers['vary'] = 'Origin';
  }
  return new Response(JSON.stringify(data), { status, headers });
}

export function corsPreflight(origin) {
  if (!origin) return new Response(null, { status: 204 });
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'POST, GET, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
      'vary': 'Origin',
    },
  });
}

export function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || '0.0.0.0';
}

export async function ipHash(salt, day, ip) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${day}:${ip}`));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
