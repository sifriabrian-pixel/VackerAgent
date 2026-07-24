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
    const prop = res.data || null;
    if (prop) {
      console.log(`[TokkoDebug] ID ${tokkoId} keys:`, Object.keys(prop).join(', '));
      console.log(`[TokkoDebug] attributes:`, JSON.stringify(prop.attributes || []).slice(0, 300));
      console.log(`[TokkoDebug] attribute_values:`, JSON.stringify(prop.attribute_values || []).slice(0, 300));
      console.log(`[TokkoDebug] tags:`, JSON.stringify(prop.tags || []).slice(0, 200));
      console.log(`[TokkoDebug] extras:`, JSON.stringify(prop.extras || prop.extra || prop.custom_tags || null).slice(0, 200));
    }
    return prop;
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

  // Helper: fetch detalle completo (con atributos, expensas, etc.) por ID
  async function fetchDetalle(propBasica) {
    const detalle = await buscarPorId(propBasica.id);
    return detalle || propBasica; // fallback a la versión básica si falla
  }

  if (candidatosCalle.length === 0) {
    if (scored.length === 1 && scored[0].score >= 2) {
      console.log(`[Tokko] Match por número: ${scored[0].prop.id} — ${scored[0].prop.address}`);
      return { prop: await fetchDetalle(scored[0].prop), candidatos: [] };
    }
    return { prop: null, candidatos: [] };
  }

  if (candidatosCalle.length === 1) {
    console.log(`[Tokko] Match único por calle: ${candidatosCalle[0].prop.id} — ${candidatosCalle[0].prop.address}`);
    return { prop: await fetchDetalle(candidatosCalle[0].prop), candidatos: [] };
  }

  // Múltiples candidatos: si uno es pautada, usarlo directamente sin preguntar
  const pautadaEnCandidatos = candidatosCalle.find(x => esPautada(x.prop.id));
  if (pautadaEnCandidatos) {
    console.log(`[Tokko] Candidato pautado: ${pautadaEnCandidatos.prop.id} — ${pautadaEnCandidatos.prop.address}`);
    return { prop: await fetchDetalle(pautadaEnCandidatos.prop), candidatos: [] };
  }

  // Sin pautada entre los candidatos → Claude pregunta
  const tops = candidatosCalle.slice(0, 4);
  console.log(`[Tokko] ${tops.length} candidatos ambiguos — Claude va a preguntar`);
  return { prop: null, candidatos: tops.map(x => x.prop) };
}

const PAUTADAS = require('../config/pautadas');

const PAUTADAS_IDS = new Set(PAUTADAS.filter(p => p.tokkoId).map(p => String(p.tokkoId)));

function buscarEnPautadas(texto) {
  const t = normalizar(texto);
  console.log(`[Pautadas] Buscando en: "${t.slice(0, 80)}"`);
  for (const p of PAUTADAS) {
    const allTerms = [...p.keywords, ...(p.address || [])];
    const matched = p.matchAny
      ? allTerms.some(k => t.includes(normalizar(k)))
      : p.keywords.every(k => t.includes(normalizar(k)));
    console.log(`[Pautadas]  keywords=${JSON.stringify(p.keywords)} → ${matched}`);
    if (matched) return p;
  }
  console.log(`[Pautadas] Sin match`);
  return null;
}

function esPautada(propId) {
  return PAUTADAS_IDS.has(String(propId));
}

async function buscarPropiedad(texto) {
  // 1. Link directo (vacker o portal con ID)
  const urlMatch = texto.match(/https?:\/\/[^\s]+/);
  if (urlMatch) {
    const id = extraerIdDesdeLink(urlMatch[0]);
    if (id) {
      console.log(`[Tokko] Buscando por ID: ${id}`);
      const prop = await buscarPorId(id);
      return { prop, candidatos: [], fichaExterna: null };
    }
  }

  // 2. Propiedad pautada en Meta Ads → match directo sin preguntar
  const pautada = buscarEnPautadas(texto);
  if (pautada) {
    if (pautada.tokkoId) {
      console.log(`[Tokko] Pautada encontrada — buscando ID: ${pautada.tokkoId}`);
      const prop = await buscarPorId(pautada.tokkoId);
      return { prop, candidatos: [], fichaExterna: null };
    }
    if (pautada.link) {
      console.log(`[Tokko] Pautada externa: ${pautada.nombre}`);
      return { prop: null, candidatos: [], fichaExterna: { link: pautada.link, nombre: pautada.nombre } };
    }
  }

  // 3. Búsqueda por texto en el inventario cacheado
  return await buscarPorTexto(texto);
}

// ─── FORMATEAR FICHA (para mostrar al lead) ───────────────────────────────────

function detectarAptoCredito(prop) {
  // Campo confirmado en Tokko API: credit_eligible
  console.log(`[TokkoDebug] credit_eligible raw: ${JSON.stringify(prop.credit_eligible)}`);
  const ce = prop.credit_eligible;
  if (ce === true  || ce === 1  || ce === '1'  || ce === 'true'  || ce === 'Si' || ce === 'si') return 'Si';
  if (ce === false || ce === 0  || ce === '0'  || ce === 'false' || ce === 'No' || ce === 'no') return 'No';
  if (ce != null) return String(ce); // cualquier otro valor no nulo lo pasamos tal cual
  // Variantes alternativas
  for (const campo of ['ap_credito', 'apto_credito', 'apt_credit', 'is_apt_credit']) {
    if (prop[campo] === true  || prop[campo] === 1) return 'Si';
    if (prop[campo] === false || prop[campo] === 0) return 'No';
  }
  // En el título
  const titulo = (prop.publication_title || '').toLowerCase();
  if (titulo.includes('apto') && (titulo.includes('credito') || titulo.includes('crédito'))) return 'Si';
  // En tags
  const tags = (prop.tags || []).map(t => (t.name || t || '').toLowerCase());
  if (tags.some(t => t.includes('credito') || t.includes('crédito'))) return 'Si';
  // En atributos
  for (const a of [...(prop.attributes || []), ...(prop.attribute_values || [])]) {
    const nombre = (a.attribute?.name || a.key || a.name || '').toLowerCase();
    const valor  = String(a.value ?? a.attribute_value ?? '').toLowerCase();
    if (nombre.includes('credito') || nombre.includes('crédito')) {
      if (valor === 'si' || valor === 'sí' || valor === '1' || valor === 'true') return 'Si';
      if (valor.includes('apto') && !valor.includes('no apto')) return 'Si';
      return valor === 'no' || valor === '0' ? 'No' : valor.charAt(0).toUpperCase() + valor.slice(1);
    }
  }
  return null;
}

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

  // Atributos detallados — combinar ambos arrays (uno puede estar vacío)
  const attrs = [...(prop.attributes || []), ...(prop.attribute_values || [])]
    .map(a => {
      const nombre = a.attribute?.name || a.key || a.name || '';
      const valor  = a.value ?? a.attribute_value ?? '';
      return nombre && valor ? `${nombre}: ${valor}` : null;
    })
    .filter(Boolean);
  const attrsTxt = attrs.length ? `\nAtributos: ${attrs.join(' | ')}` : '';

  // Apto crédito — detección explícita en múltiples campos
  const aptoCredito = detectarAptoCredito(prop);
  const aptoCreditoTxt = aptoCredito ? `\nApto crédito: ${aptoCredito}` : '\nApto crédito: no figura en ficha';
  console.log(`[Tokko] Apto crédito ID ${prop.id}: ${aptoCredito || 'no detectado'}`);

  // Campos top-level confirmados en Tokko API
  const expensas    = prop.expenses      ? `\nExpensas: $${Number(prop.expenses).toLocaleString('es-AR')}` : '';
  const antiguedad  = prop.age           ? `\nAntigüedad: ${prop.age} años` : '';
  const orientacion = prop.orientation   ? `\nOrientación: ${prop.orientation}` : '';
  const disposicion = prop.disposition   ? `\nDisposición: ${prop.disposition}` : '';
  const situacion   = prop.situation     ? `\nSituación: ${prop.situation}` : '';
  const cocheras    = prop.parking_lot_amount != null ? `\nCocheras: ${prop.parking_lot_amount}` : '';

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
Superficie total: ${prop.total_surface ? prop.total_surface + 'm²' : '—'}${aptoCreditoTxt}${expensas}${antiguedad}${orientacion}${disposicion}${situacion}${cocheras}${tagsTxt}${attrsTxt}${desc}${url}`;
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
