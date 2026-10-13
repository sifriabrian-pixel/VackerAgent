// Links de portales (ZonaProp, Mercado Libre, Argenprop…): detectarlos en un
// mensaje y leer de qué propiedad hablan.
const config = require('../config/vacker');

const URL_RE = /https?:\/\/[^\s]+/gi;

// Devuelve { portal, url } del primer link de un portal conocido, o null.
function detectar(texto) {
  for (const url of String(texto || '').match(URL_RE) || []) {
    const u = url.toLowerCase();
    const portal = config.filtro.portales.find((p) => u.includes(p.dominio));
    if (portal) return { portal: portal.nombre, url: url.replace(/[).,;]+$/, '') };
  }
  return null;
}

// Lo que dice la URL sola: "…/casa-en-venta-en-funes-3-dormitorios-49761234.html"
function textoDeUrl(url) {
  try {
    return decodeURIComponent(new URL(url).pathname).replace(/\.\w+$/, '').replace(/[/_-]+/g, ' ').trim();
  } catch {
    return '';
  }
}

// Abre la publicación y devuelve el texto que la identifica (dirección y
// título). Los portales a veces bloquean a los servidores: si falla, devuelve
// null y quien llama se arregla con la URL. Nunca lanza.
async function leer(url, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(6000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'es-AR,es;q=0.9',
      },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const partes = [];
    for (const m of html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        for (const item of [].concat(JSON.parse(m[1]))) {
          const calle = item?.address?.streetAddress || item?.location?.address?.streetAddress;
          if (calle) partes.push(calle);
          if (item?.name) partes.push(item.name);
        }
      } catch { /* JSON-LD roto: se ignora */ }
    }
    const og = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)?.[1];
    const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];
    if (og) partes.push(og);
    if (title) partes.push(title);
    return partes.length ? partes.join(' | ') : null;
  } catch {
    return null;
  }
}

module.exports = { detectar, textoDeUrl, leer };
