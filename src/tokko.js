// tokko.js — integración con Tokko Broker API

const axios = require('axios');

const TOKKO_API_KEY = process.env.TOKKO_API_KEY;
const BASE_URL = 'https://tokkobroker.com/api/v1';

// Crear contacto/lead en Tokko
async function crearContacto(lead) {
  if (!TOKKO_API_KEY) {
    console.log('[Tokko] API key no configurada, saltando creación de contacto');
    return null;
  }

  try {
    const payload = {
      api_key: TOKKO_API_KEY,
      name: lead.nombre || `Lead WhatsApp ${lead.telefono}`,
      phone: lead.telefono,
      email: '',
      tags: ['WhatsApp', 'Meta Ads'],
      comment: buildComentario(lead),
    };

    // Si hay propiedad de interés, agregarla
    if (lead.propiedadInteresId) {
      payload.properties = [lead.propiedadInteresId];
    }

    const res = await axios.post(`${BASE_URL}/contact/`, payload);
    console.log(`[Tokko] Contacto creado OK — ID: ${res.data?.id}`);
    return res.data;

  } catch (err) {
    console.error('[Tokko] Error creando contacto:', err?.response?.data || err.message);
    return null;
  }
}

// Construir comentario enriquecido para Tokko
function buildComentario(lead) {
  const partes = ['Lead calificado vía WhatsApp.'];
  if (lead.operacion) partes.push(`Operación: ${lead.operacion}.`);
  if (lead.zona) partes.push(`Zona: ${lead.zona}.`);
  if (lead.ambientes) partes.push(`Ambientes: ${lead.ambientes}.`);
  if (lead.presupuesto) partes.push(`Presupuesto: ${lead.presupuesto}.`);
  if (lead.disponibleEn) partes.push(`Disponibilidad: ${lead.disponibleEn.toLocaleDateString('es-AR')}.`);
  return partes.join(' ');
}

module.exports = { crearContacto };
