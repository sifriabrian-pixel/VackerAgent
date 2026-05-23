// tokko.js — integración completa con Tokko Broker API

const axios = require('axios');

const API_KEY  = process.env.TOKKO_API_KEY;
const BASE_URL = 'https://www.tokkobroker.com/api/v1';

// ─── BUSCAR PROPIEDAD ─────────────────────────────────────────────────────────

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

// Busca propiedad solo si el mensaje tiene un link — no por dirección
async function buscarPropiedad(texto) {
  const urlMatch = texto.match(/https?:\/\/[^\s]+/);
  if (urlMatch) {
    const id = extraerIdDesdeLink(urlMatch[0]);
    if (id) {
      console.log(`[Tokko] Buscando por ID: ${id}`);
      return await buscarPorId(id);
    }
  }
  return null;
}

// ─── FORMATEAR FICHA ──────────────────────────────────────────────────────────

function formatearFicha(prop) {
  if (!prop) return null;
  const ops = prop.operations?.[0];
  const operacion = ops?.operation_type === 1 ? 'Venta' : ops?.operation_type === 2 ? 'Alquiler' : 'Consultar';
  const precio = ops?.prices?.[0]
    ? `${ops.prices[0].currency} ${ops.prices[0].price?.toLocaleString('es-AR')}`
    : 'Consultar';

  return `🏠 ${prop.publication_title || prop.address}
📍 Dirección: ${prop.address || '—'}
🏙️ Barrio: ${prop.location?.name || '—'}
📋 Operación: ${operacion}
💰 Precio: ${precio}
✨ Ambientes: ${prop.room_amount || '—'}
🛏️ Habitaciones: ${prop.bedroom_amount || '—'}
🚿 Baños: ${prop.bathroom_amount || '—'}
📐 Superficie total: ${prop.total_surface ? prop.total_surface + 'm²' : '—'}
🔗 Ver ficha completa: https://www.vacker.com.ar/p/${prop.id}`;
}

// ─── CREAR CONTACTO ───────────────────────────────────────────────────────────

async function crearContacto(lead) {
  if (!API_KEY) {
    console.log('[Tokko] API key no configurada');
    return null;
  }
  try {
    const payload = {
      api_key: API_KEY,
      name: lead.nombre || `Lead WhatsApp ${lead.telefono}`,
      phone: lead.telefono,
      mail: lead.email || 'sin-email@whatsapp.com',
      comment: buildComentario(lead),
      tags: ['WhatsApp', 'Meta Ads'],
    };

    // publication_id es requerido — usamos el ID de la propiedad de interés si existe
    if (lead.propiedadTokkoId) {
      payload.publication_id = String(lead.propiedadTokkoId);
      payload.properties = [lead.propiedadTokkoId];
    }

    const res = await axios.post(
      `http://tokkobroker.com/portals/simple_portal/api/v1/contact/`,
      payload,
      { headers: { 'Content-Type': 'application/json' } }
    );
    console.log(`[Tokko] Contacto creado OK — ID: ${res.data?.id}`);
    return res.data;
  } catch (err) {
    console.error('[Tokko] Error creando contacto:', err?.response?.data || err.message);
    return null;
  }
}

function buildComentario(lead) {
  const partes = ['Lead calificado via WhatsApp.'];
  if (lead.operacion)    partes.push(`Operacion: ${lead.operacion}.`);
  if (lead.zona)         partes.push(`Zona: ${lead.zona}.`);
  if (lead.ambientes)    partes.push(`Ambientes: ${lead.ambientes}.`);
  if (lead.presupuesto)  partes.push(`Presupuesto: ${lead.presupuesto}.`);
  if (lead.disponibleEn) partes.push(`Disponibilidad: ${lead.disponibleEn.toLocaleDateString('es-AR')}.`);
  return partes.join(' ');
}

module.exports = { buscarPropiedad, formatearFicha, crearContacto };
