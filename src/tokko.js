// tokko.js — integración con Tokko Broker API

const axios = require('axios');

const API_KEY    = process.env.TOKKO_API_KEY;
const AGENT_ID   = process.env.TOKKO_AGENT_ID;
const BASE_URL   = 'https://www.tokkobroker.com/api/v1';

// ─── INVENTARIO EN MEMORIA ────────────────────────────────────────────────────

let inventarioCache = [];
let ultimaActualizacion = null;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hora

async function obtenerInventario() {
  const ahora = Date.now();
  if (inventarioCache.length > 0 && ultimaActualizacion && (ahora - ultimaActualizacion) < CACHE_TTL_MS) {
    return inventarioCache;
  }

  if (!API_KEY) {
    console.warn('[Tokko] TOKKO_API_KEY no configurada — inventario vacío');
    return [];
  }

  try {
    // Tokko no permite filtrar por producer en el query, hay que paginar y filtrar client-side
    const agentId = AGENT_ID ? parseInt(AGENT_ID) : null;
    let todas = [];
    let offset = 0;
    const LIMIT = 100;

    while (true) {
      const res = await axios.get(`${BASE_URL}/property/`, {
        params: { format: 'json', key: API_KEY, lang: 'es_ar', limit: LIMIT, availability: 2, offset },
      });
      const lote = res.data?.objects || [];
      if (!lote.length) break;
      todas = todas.concat(lote);
      const total = res.data?.meta?.total_count || 0;
      offset += LIMIT;
      if (offset >= total) break;
    }

    // Filtrar por productor/asesor si está configurado
    const propiedades = agentId
      ? todas.filter(p => p.id && p.producer?.id === agentId)
      : todas.filter(p => p.id);

    inventarioCache = propiedades;
    ultimaActualizacion = ahora;

    console.log(`[Tokko] Inventario: ${propiedades.length} propiedades${agentId ? ` del asesor ${agentId}` : ''} (${todas.length} total cuenta)`);
    return inventarioCache;
  } catch (err) {
    console.error('[Tokko] Error obteniendo inventario:', err?.response?.data || err.message);
    return inventarioCache;
  }
}

function generarUrlVacker(p) {
  const titulo = p.publication_title || p.address || '';
  const slug = titulo
    .replace(/ - /g, '-')
    .replace(/²/g, '2').replace(/³/g, '3')
    .replace(/\s+/g, '-');
  return `https://www.vacker.com.ar/p/${p.id}-${slug}`;
}

function formatearInventarioParaPrompt(propiedades) {
  if (!propiedades.length) return 'Sin propiedades disponibles en este momento.';

  return propiedades.map((p, i) => {
    const ops = p.operations?.[0];
    const opType = ops?.operation_type;
    const operacion = (opType === 1 || opType === 'Sale') ? 'Venta'
                    : (opType === 2 || opType === 'Rent') ? 'Alquiler'
                    : 'Consultar';
    const precio = ops?.prices?.[0]
      ? `${ops.prices[0].currency} ${ops.prices[0].price?.toLocaleString('es-AR')}`
      : 'Consultar';

    const url = `\n${generarUrlVacker(p)}`;
    return `PROPIEDAD ${i + 1} (ID: ${p.id}):
${p.publication_title || p.address}
${p.address || '—'} | ${p.location?.name || '—'}
${operacion} | ${precio}
${p.room_amount || '—'} amb | ${p.bedroom_amount || '—'} hab | ${p.bathroom_amount || '—'} baños | ${p.total_surface ? p.total_surface + 'm²' : '—'}${url}`;
  }).join('\n\n');
}

// ─── BUSCAR PROPIEDAD POR LINK ────────────────────────────────────────────────

async function buscarPorId(tokkoId) {
  try {
    const res = await axios.get(`${BASE_URL}/property/${tokkoId}/`, {
      params: { format: 'json', key: API_KEY, lang: 'es_ar' },
    });
    return res.data || null;
  } catch (err) {
    console.error('[Tokko] Error buscando por ID:', err?.response?.data || err.message);
    return null;
  }
}

function extraerIdDesdeLink(url) {
  const vackerMatch = url.match(/vacker\.com\.ar\/p\/(\d+)/);
  if (vackerMatch) return vackerMatch[1];
  const zonaMatch = url.match(/(\d{6,})[^/]*\.html/);
  if (zonaMatch) return zonaMatch[1];
  const genericMatch = url.match(/\/(\d{6,})/);
  if (genericMatch) return genericMatch[1];
  return null;
}

function normalizar(str) {
  return (str || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

const STOPWORDS = new Set([
  'interesa', 'propiedad', 'depto', 'departamento', 'casa', 'local', 'venta',
  'alquiler', 'busco', 'quiero', 'zona', 'barrio', 'calle', 'esta', 'tiene',
  'para', 'con', 'del', 'los', 'las', 'una', 'como', 'hola', 'buen', 'gracias',
  'quisiera', 'saber', 'sobre', 'puedo', 'puedes', 'podrias', 'informacion',
]);

async function buscarPorTexto(texto) {
  const inventario = await obtenerInventario();
  if (!inventario.length) return null;

  const t = normalizar(texto);
  const numeros  = t.match(/\b\d{3,5}\b/g) || [];
  const palabras = t.split(/\s+/).filter(p => p.length > 3 && !STOPWORDS.has(p));

  const scored = inventario.map(prop => {
    const dir    = normalizar(prop.address);
    const titulo = normalizar(prop.publication_title);
    const zona   = normalizar(prop.location?.name);
    let score = 0;
    let calleMatch = false;

    // Solo la parte antes del número es la calle principal
    const numPos = dir.search(/\b\d{3,5}\b/);
    const callePrincipal = numPos > 0 ? dir.slice(0, numPos) : dir;

    // Nombre de calle en dirección → señal más fuerte
    for (const pal of palabras) {
      if (callePrincipal.includes(pal)) {
        // Coincide con la calle principal (antes del número)
        score += 6;
        calleMatch = true;
      } else if (dir.includes(pal)) {
        // Aparece en la dirección pero no como calle principal (ej: transversal)
        score += 1;
      } else if (zona.includes(pal) || titulo.includes(pal)) {
        score += 1;
      }
    }

    // Número en dirección → señal secundaria
    for (const num of numeros) {
      if (dir.includes(num)) score += 2;
    }

    return { prop, score, calleMatch };
  })
  .filter(x => x.score > 0)
  .sort((a, b) => {
    // 1. Calle match primero
    if (a.calleMatch !== b.calleMatch) return b.calleMatch ? 1 : -1;
    // 2. Score mayor
    if (a.score !== b.score) return b.score - a.score;
    // 3. Desempate: número más cercano al mencionado en el texto
    if (numeros.length) {
      const queryNum = parseInt(numeros[0]);
      const numA = parseInt((a.prop.address || '').match(/\b\d{3,5}\b/)?.[0] || '0');
      const numB = parseInt((b.prop.address || '').match(/\b\d{3,5}\b/)?.[0] || '0');
      return Math.abs(queryNum - numA) - Math.abs(queryNum - numB);
    }
    return 0;
  });

  const candidatosCalle = scored.filter(x => x.calleMatch);

  if (candidatosCalle.length === 0) {
    // Sin match de calle, usar número si hay un único resultado claro
    if (scored.length === 1 && scored[0].score >= 2) {
      console.log(`[Tokko] Match por número: ${scored[0].prop.id} — ${scored[0].prop.address}`);
      return { prop: scored[0].prop, candidatos: [] };
    }
    return { prop: null, candidatos: [] };
  }

  if (candidatosCalle.length === 1) {
    // Único match de calle → certeza alta
    console.log(`[Tokko] Match único por calle: ${candidatosCalle[0].prop.id} — ${candidatosCalle[0].prop.address}`);
    return { prop: candidatosCalle[0].prop, candidatos: [] };
  }

  // Múltiples candidatos con la misma calle → devolver todos para que Claude pregunte
  const tops = candidatosCalle.slice(0, 4);
  console.log(`[Tokko] ${tops.length} candidatos en misma calle — Claude va a preguntar`);
  return { prop: null, candidatos: tops.map(x => x.prop) };
}

async function buscarPropiedad(texto) {
  // 1. Link directo (vacker o portal con ID)
  const urlMatch = texto.match(/https?:\/\/[^\s]+/);
  if (urlMatch) {
    const id = extraerIdDesdeLink(urlMatch[0]);
    if (id) {
      console.log(`[Tokko] Buscando por ID: ${id}`);
      const prop = await buscarPorId(id);
      return { prop, candidatos: [] };
    }
  }
  // 2. Búsqueda por texto en el inventario cacheado (flujo principal Meta/portales)
  return await buscarPorTexto(texto);
}

// ─── FORMATEAR FICHA (para mostrar al lead) ───────────────────────────────────

function formatearFicha(prop) {
  if (!prop) return null;
  const ops = prop.operations?.[0];
  const opType = ops?.operation_type;
  const operacion = (opType === 1 || opType === 'Sale') ? 'Venta'
                  : (opType === 2 || opType === 'Rent') ? 'Alquiler'
                  : 'Consultar';
  const precio = ops?.prices?.[0]
    ? `${ops.prices[0].currency} ${ops.prices[0].price?.toLocaleString('es-AR')}`
    : 'Consultar';

  const tags = (prop.tags || []).map(t => t.name || t).filter(Boolean);
  const tagsTxt = tags.length ? `\nCaracterísticas: ${tags.join(', ')}` : '';

  // Atributos detallados (acá vive "Apto crédito", expensas, antigüedad, etc.)
  const attrs = (prop.attributes || prop.attribute_values || [])
    .map(a => {
      const nombre = a.attribute?.name || a.key || a.name || '';
      const valor  = a.value ?? a.attribute_value ?? '';
      return nombre && valor ? `${nombre}: ${valor}` : null;
    })
    .filter(Boolean);
  const attrsTxt = attrs.length ? `\nAtributos: ${attrs.join(' | ')}` : '';

  const desc = prop.description ? `\nDescripción: ${prop.description.replace(/<[^>]*>/g, '').slice(0, 400)}` : '';
  const url = `\nVer en web: ${generarUrlVacker(prop)}`;
  return `${prop.publication_title || prop.address}
Dirección: ${prop.address || '—'}
Barrio: ${prop.location?.name || '—'}
Operación: ${operacion}
Precio: ${precio}
Ambientes: ${prop.room_amount || '—'}
Habitaciones: ${prop.bedroom_amount || '—'}
Baños: ${prop.bathroom_amount || '—'}
Superficie total: ${prop.total_surface ? prop.total_surface + 'm²' : '—'}${tagsTxt}${attrsTxt}${desc}${url}`;
}

// ─── CREAR CONSULTA EN TOKKO (solo para leads de Meta) ───────────────────────

async function crearContacto(lead) {
  if (!API_KEY) {
    console.log('[Tokko] API key no configurada');
    return null;
  }
  try {
    const telefonoLimpio = (lead.telefono || '')
      .replace(/@.*$/, '')
      .replace(/[^0-9]/g, '')
      .slice(-13);

    const payload = {
      name: lead.nombre || 'Lead WhatsApp',
      phone: telefonoLimpio,
      cellphone: telefonoLimpio,
      email: lead.email || '',
      text: buildComentario(lead),
      tags: ['WhatsApp', 'Meta Ads'],
    };

    if (lead.propiedadTokkoId) payload.properties = [lead.propiedadTokkoId];

    console.log('[Tokko] Creando consulta para:', payload.name, '—', telefonoLimpio);

    const res = await axios.post(
      `${BASE_URL}/webcontact/?key=${API_KEY}`,
      payload,
      { headers: { 'Content-Type': 'application/json' } }
    );
    console.log('[Tokko] Consulta creada OK');
    return res.data;
  } catch (err) {
    console.error('[Tokko] Error creando consulta:', err?.response?.data || err.message);
    return null;
  }
}

function buildComentario(lead) {
  const partes = ['Lead calificado via WhatsApp (Meta Ads).'];
  if (lead.operacion)    partes.push(`Operacion: ${lead.operacion}.`);
  if (lead.zona)         partes.push(`Zona: ${lead.zona}.`);
  if (lead.ambientes)    partes.push(`Ambientes: ${lead.ambientes}.`);
  if (lead.presupuesto)  partes.push(`Presupuesto: ${lead.presupuesto}.`);
  if (lead.disponibleEn) partes.push(`Disponibilidad: ${lead.disponibleEn.toLocaleDateString('es-AR')}.`);
  return partes.join(' ');
}

const PORTALES_EXTERNOS = [
  { nombre: 'ZonaProp', dominio: 'zonaprop.com.ar' },
  { nombre: 'Argenprop', dominio: 'argenprop.com' },
  { nombre: 'MercadoLibre', dominio: 'inmuebles.mercadolibre.com.ar' },
  { nombre: 'Properati', dominio: 'properati.com.ar' },
  { nombre: 'Navent', dominio: 'navent.com' },
];

function detectarPortal(texto) {
  const t = texto.toLowerCase();
  const match = PORTALES_EXTERNOS.find(p => t.includes(p.dominio));
  return match ? match.nombre : null;
}

module.exports = { obtenerInventario, formatearInventarioParaPrompt, buscarPropiedad, formatearFicha, crearContacto, detectarPortal };
