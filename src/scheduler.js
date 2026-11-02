// Seguimientos automáticos por inactividad.
//
// 24h sin respuesta → template 'vacker_seguimiento_24h' al lead
// 48h sin respuesta → template 'vacker_seguimiento_48h' al lead
//
// IMPORTANTE: Las plantillas deben estar aprobadas en Meta Business Manager
// antes de activar. Registrarlas en Kapso → Configuración → Plantillas.
// Nombres exactos: vacker_seguimiento_24h, vacker_seguimiento_48h
//
// Mientras no estén aprobadas, los envíos fallan con error 132001 de Meta
// y quedan logueados sin interrumpir el proceso.
const cron = require('node-cron');
const repo = require('./repo');
const clock = require('./clock');

let provider = null;
function setProvider(p) { provider = p; }

async function enviarFollowup(lead, templateName, campo) {
  try {
    if (!provider?.sendTemplate) throw new Error('el proveedor no soporta plantillas');
    await provider.sendTemplate(lead.numero, templateName);
    repo.updateLead(lead.numero, { [campo]: clock.nowISO() });
    repo.addEvent(lead.numero, `followup_${campo.replace('followup_', '').replace('_at', '')}`, { template: templateName });
    console.log(`[scheduler] ${templateName} → ${lead.numero} (${lead.nombre_perfil || 'sin nombre'})`);
  } catch (e) {
    console.error(`[scheduler] Error enviando ${templateName} a ${lead.numero}:`, e.message);
    repo.addEvent(lead.numero, 'followup_error', { template: templateName, error: e.message });
  }
}

async function chequearFollowups() {
  const leads24h = repo.leadsParaFollowup(24, 'followup_24h_at');
  const leads48h = repo.leadsParaFollowup(48, 'followup_48h_at');

  for (const lead of leads24h) {
    await enviarFollowup(lead, 'vacker_seguimiento_24h', 'followup_24h_at');
  }
  for (const lead of leads48h) {
    await enviarFollowup(lead, 'vacker_seguimiento_48h', 'followup_48h_at');
  }

  if (leads24h.length || leads48h.length) {
    console.log(`[scheduler] Followups: 24h=${leads24h.length} 48h=${leads48h.length}`);
  }
}

function init() {
  // Corre cada 15 minutos
  cron.schedule('*/15 * * * *', () => {
    chequearFollowups().catch((e) => console.error('[scheduler] Error en chequeo:', e.message));
  });
  console.log('[scheduler] Seguimientos automáticos activados (cada 15 min)');
}

module.exports = { init, setProvider };
