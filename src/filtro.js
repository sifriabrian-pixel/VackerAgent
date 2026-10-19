// Filtro lead / contacto personal. Función pura: no sabe nada del proveedor
// de WhatsApp. Decide qué hacer con un mensaje ENTRANTE; los mensajes que
// manda el asesor nunca pasan por acá (nunca son un lead).
//
// La regla de fondo: Pablo agenda a todos los que conoce. Un número que no está
// en su agenda (ni en chats que él ya tenía, ni le escribió él primero) es un lead,
// venga o no con link o anuncio.
//
// Orden:
//   1. bloqueado                             → ignorar
//   2. ya es un lead                         → lead
//   3. conocido o personal                   → personal
//   4. la agenda todavía no se pudo cargar   → ignorar (sin agenda no se puede distinguir)
//   5. está en la agenda                     → personal
//   6. cualquier otro número                 → lead (canal según anuncio / link / directo)
const portales = require('./portales');

function decidir({ contacto, input, agenda }) {
  const referral = input.metadata?.referral || null;
  const tipo = contacto?.tipo || null;

  if (tipo === 'bloqueado') return { decision: 'ignorar', motivo: 'bloqueado' };
  if (tipo === 'lead') return { decision: 'lead', motivo: 'lead_activo' };
  if (tipo === 'conocido' || tipo === 'personal' || tipo === 'pendiente') {
    return { decision: 'personal', motivo: tipo === 'conocido' ? `conocido_${contacto.origen || ''}` : 'marcado_personal' };
  }

  if (!agenda?.estaCargada()) return { decision: 'ignorar', motivo: 'agenda_no_cargada' };
  if (agenda.tiene(input.from || input.conversationId)) return { decision: 'personal', motivo: 'agendado' };

  if (referral) return { decision: 'lead', motivo: 'anuncio', canal: 'meta' };
  const link = portales.detectar(input.text);
  if (link) return { decision: 'lead', motivo: `link_${link.portal.toLowerCase().replace(/\s/g, '_')}`, canal: 'portal' };
  return { decision: 'lead', motivo: 'no_agendado', canal: 'directo' };
}

module.exports = { decidir };
