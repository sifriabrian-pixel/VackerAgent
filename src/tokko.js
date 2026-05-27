// tokko.js — integración con Tokko Broker API

const axios = require('axios');

const API_KEY  = process.env.TOKKO_API_KEY;
const BASE_URL = 'https://www.tokkobroker.com/api/v1';

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
  const opType = ops?.operation_type;
  const operacion = (opType === 1 || opType === 'Sale') ? 'Venta'
                  : (opType === 2 || opType === 'Rent') ? 'Alquiler'
                  : 'Consultar';
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

// ─── CREAR CONSULTA EN TOKKO (solo para leads de Meta) ───────────────────────

async function crearContacto(lead) {
  if (!API_KEY) {
    console.log('[Tokko] API key no configurada');
    return null;
  }
  try {
    // Limpiar teléfono — sacar sufijo @lid o @s.whatsapp.net
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

    if (lead.propiedadTokkoId) {
      payload.properties = [lead.propiedadTokkoId];
    }

    console.log('[Tokko] Creando consulta para:', payload.name, '—', telefonoLimpio);

    const res = await axios.post(
      `https://www.tokkobroker.com/api/v1/webcontact/?key=${API_KEY}`,
      payload,
      { headers: { 'Content-Type': 'application/json' } }
    );
    console.log(`[Tokko] Consulta creada OK`);
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

module.exports = { buscarPropiedad, formatearFicha, crearContacto };
