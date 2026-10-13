// Filtro lead / contacto personal. Función pura: no sabe nada del proveedor
// de WhatsApp. Decide qué hacer con un mensaje ENTRANTE; los mensajes que
// manda el asesor nunca pasan por acá (nunca son un lead).
//
// Orden:
//   1. bloqueado                         → ignorar
//   2. ya es un lead                     → lead
//   3. conocido o personal               → personal (con anuncio → pendiente)
//   4. viene de un anuncio (metadata)    → lead
//   5. trae un link de un portal         → lead
//   6. no se puede decidir               → pendiente (lo resuelve el clasificador o una persona)
const portales = require('./portales');

function decidir({ contacto, input }) {
  const referral = input.metadata?.referral || null;
  const tipo = contacto?.tipo || null;

  if (tipo === 'bloqueado') return { decision: 'ignorar', motivo: 'bloqueado' };
  if (tipo === 'lead') return { decision: 'lead', motivo: 'lead_activo' };

  if (tipo === 'conocido' || tipo === 'personal') {
    // Un contacto del asesor que entra por un anuncio: no se responde solo, se revisa.
    if (referral) return { decision: 'pendiente', motivo: 'conocido_con_anuncio' };
    return { decision: 'personal', motivo: tipo === 'conocido' ? `conocido_${contacto.origen || ''}` : 'marcado_personal' };
  }

  if (referral) return { decision: 'lead', motivo: 'anuncio', canal: 'meta' };

  const link = portales.detectar(input.text);
  if (link) return { decision: 'lead', motivo: `link_${link.portal.toLowerCase().replace(/\s/g, '_')}`, canal: 'portal' };

  return { decision: 'pendiente', motivo: tipo === 'pendiente' ? 'sigue_pendiente' : 'sin_senal' };
}

module.exports = { decidir };
