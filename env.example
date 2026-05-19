// prompts/vacker.js — todo el texto del agente en un solo lugar
// Para actualizar propiedades o tono, solo tocar este archivo

// ─── INVENTARIO ──────────────────────────────────────────────────────────────
// Reemplazar con el inventario real cuando lo provea el cliente
// Formato: array de objetos con los campos de cada propiedad
const PROPIEDADES = [
  {
    id: 'prop_001',
    titulo: 'Departamento 2 dormitorios en Centro — San Juan al 2100',
    direccion: 'San Juan al 2100, piso 4, entre Bv. Oroño y Balcarce',
    barrio: 'Centro',
    operacion: 'Venta',
    precio: 'USD 112.000',
    ambientes: 5,
    habitaciones: 2,
    banos: '1 completo + 1 toilette',
    superficie: '79m² (71m² cubiertos + 7m² semicubiertos)',
    link: 'https://www.vacker.com.ar/p/7084056-Departamento-en-Venta-en-Centro-San-Juan-al-2100',
    extras: 'Apto crédito, balcón, edificio con ascensor y terraza común',
  },
  {
    id: 'prop_002',
    titulo: 'Departamento semipiso 2 dormitorios en Barrio Martín — Pellegrini al 400',
    direccion: 'Pellegrini al 400, entre 1 de Mayo y Alem',
    barrio: 'Martín',
    operacion: 'Venta',
    precio: 'USD 105.000',
    ambientes: 4,
    habitaciones: 2,
    banos: '1',
    superficie: '82m² (64m² cubiertos + 18m² de doble balcón)',
    link: 'https://www.vacker.com.ar/p/7912397-Departamento-en-Venta-en-Martin-Pellegrini--al-400',
    extras: 'Semipiso, doble balcón, zona gastronómica, cerca Parque Urquiza',
  },
  // Agregar más propiedades acá cuando el cliente las provea
];

function formatearFicha(prop) {
  return `🏠 ${prop.titulo}
📍 Dirección: ${prop.direccion}
🏙️ Barrio: ${prop.barrio}
📋 Operación: ${prop.operacion}
💰 Precio: ${prop.precio}
✨ Ambientes: ${prop.ambientes}
🛏️ Habitaciones: ${prop.habitaciones}
🚿 Baños: ${prop.banos}
📐 Superficie total: ${prop.superficie}
🔗 Ver ficha completa: ${prop.link}`;
}

// ─── MENSAJES FIJOS ───────────────────────────────────────────────────────────
const MENSAJES = {
  reminder: (fecha) =>
    `Hola! Te escribimos de Vacker para recordarte que mañana tenés una visita agendada${fecha ? ` el ${fecha}` : ''}. ¿Confirmamos? 😊`,

  postVisita:
    `Hola! ¿Cómo te fue con la visita? ¿Qué te pareció la propiedad? Si tenés alguna consulta o querés ver otras opciones, avisanos. 🏠`,

  followup24:
    `Hola! Quería retomarte por si te quedó alguna duda sobre la propiedad. Estamos disponibles para lo que necesites. 😊`,

  followup48:
    `Hola, último mensaje de nuestra parte. Si en algún momento retomás la búsqueda, no dudes en escribirnos. ¡Éxitos! 🙌`,
};

// ─── TRIGGER STRINGS ─────────────────────────────────────────────────────────
// Mensajes pre-cargados que activan el agente (configurar en Meta Ads y portales)
const ACTIVATION_TRIGGERS = [
  'vi tu anuncio en instagram',
  'vi tu anuncio en facebook',
  'me interesa conocer más sobre las propiedades',
  'me interesa conocer mas sobre las propiedades',
  'información sobre propiedades',
  'informacion sobre propiedades',
  'vi la publicación en zonaprop',
  'vi la publicación en argenprop',
  // Agregar más cuando Felipe confirme el texto exacto de los anuncios
];

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
function getSystemPrompt() {
  const inventario = PROPIEDADES.map((p, i) =>
    `PROPIEDAD ${i + 1} (ID: ${p.id}):\n${formatearFicha(p)}\nExtras: ${p.extras}`
  ).join('\n\n');

  return `Sos el agente de IA de Vacker Negocios Inmobiliarios, inmobiliaria de Rosario, Argentina.
Atendés leads que llegan por WhatsApp desde anuncios de Instagram, Facebook o portales inmobiliarios.
El asesor a cargo es Ezequiel.

INVENTARIO ACTUAL:
${inventario}

FLUJO DE CONVERSACIÓN:
1. Saludá de forma natural y cálida. Preguntá en qué podés ayudar o por qué propiedad se contacta.
2. Cuando el lead mencione una propiedad, presentá la ficha con el formato exacto del inventario.
3. Si no queda claro cuál propiedad, preguntá amablemente por cuál se contacta.
4. Cuando el lead muestre interés real en visitar, informale que Ezequiel se va a poner en contacto para coordinar.

TRIGGERS — incluí estos tokens en tu respuesta cuando corresponda (no los muestra el lead):
- Cuando el lead esté calificado (tenés nombre, operación, zona, presupuesto): incluí [LEAD_QUALIFIED]
- Cuando el lead confirme que quiere visitar o hablar con el asesor: incluí [HANDOFF_TRIGGER]
- Cuando termine tu respuesta y aún no se obtuvo visita ni handoff: incluí [FOLLOWUP_TRIGGER]
- Cuando el lead mencione que tiene dinero disponible en una fecha futura: incluí [FUTURE_DATE]

REGLAS:
- Español rioplatense natural, sin formalidades excesivas ni emojis exagerados.
- No más de 2 preguntas por mensaje.
- Al presentar una propiedad, usá siempre el formato de ficha exacto del inventario.
- Si el lead menciona fecha futura para el dinero, confirmá que lo tenés anotado y que lo van a contactar.
- No inventes propiedades fuera del inventario.`;
}

module.exports = { getSystemPrompt, ACTIVATION_TRIGGERS, MENSAJES, PROPIEDADES };
