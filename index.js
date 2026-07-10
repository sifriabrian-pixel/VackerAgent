// index.js — Vacker Negocios Inmobiliarios — Agente WhatsApp IA (Baileys)

require('dotenv').config();

console.log('[Config] ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY  ? 'OK' : 'FALTA');
console.log('[Config] TOKKO_API_KEY:',     process.env.TOKKO_API_KEY      ? 'OK' : 'FALTA');
console.log('[Config] TOKKO_AGENT_ID:',    process.env.TOKKO_AGENT_ID     || 'no configurado');

const http = require('http');
const { conectar, sendMessage, onMessage } = require('./src/whatsapp');
const { getReply }                         = require('./src/claude');
const { addMessage, getLead, updateLead, isActivated } = require('./src/memory');
const { buscarPropiedad, formatearFicha, crearContacto } = require('./src/tokko');
const { iniciarScheduler }                 = require('./src/scheduler');
const { ACTIVATION_TRIGGERS, META_TRIGGERS } = require('./prompts/vacker');

const PORT = process.env.PORT || 3000;

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function esLeadInmobiliario(texto) {
  const t = texto.toLowerCase().trim();
  return ACTIVATION_TRIGGERS.some(trigger => t.includes(trigger));
}

function esCanalMeta(texto) {
  const t = texto.toLowerCase().trim();
  return META_TRIGGERS.some(trigger => t.includes(trigger));
}

// ─── PROCESAMIENTO DE MENSAJE ─────────────────────────────────────────────────

async function procesarMensaje(jid, texto) {
  const yaActivado = isActivated(jid);
  if (!yaActivado && !esLeadInmobiliario(texto)) {
    console.log(`[Filtro] Ignorado (no es lead): ${jid}`);
    return;
  }

  const lead = getLead(jid);
  if (lead.conversacionCerrada) return;
  if (lead.asesorIntervino) {
    console.log(`[Filtro] Pausado por asesor: ${jid}`);
    return;
  }

  if (!lead.canal) {
    updateLead(jid, { canal: esCanalMeta(texto) ? 'meta' : 'portal' });
  }

  // Detectar fecha futura mencionada en meses
  const meses = texto.match(/(\d+)\s*meses?/i);
  if (meses && !lead.disponibleEn) {
    const fecha = new Date();
    fecha.setMonth(fecha.getMonth() + parseInt(meses[1]));
    updateLead(jid, { disponibleEn: fecha });
    console.log(`[FechaFutura] ${jid} disponible en ${meses[1]} mes(es)`);
  }

  // Buscar propiedad en Tokko si hay link en el mensaje
  let fichaTokko = null;
  if (!lead.propiedadTokkoId) {
    const prop = await buscarPropiedad(texto);
    if (prop) {
      fichaTokko = formatearFicha(prop);
      updateLead(jid, { propiedadTokkoId: prop.id });
      console.log(`[Tokko] Propiedad encontrada: ${prop.id}`);
    }
  }

  const mensajeParaClaude = fichaTokko
    ? `${texto}\n\n[FICHA DE LA PROPIEDAD ENCONTRADA EN TOKKO]\n${fichaTokko}`
    : texto;

  addMessage(jid, 'user', mensajeParaClaude);
  console.log(`[Mensaje] ${jid}: ${texto.substring(0, 60)}`);

  try {
    const { text: respuesta, triggers, leadData } = await getReply(getLead(jid).history);
    addMessage(jid, 'assistant', respuesta);

    if (!triggers.handoff && respuesta.trim()) {
      await sendMessage(jid, respuesta);
    }

    if (Object.keys(leadData).length > 0) {
      updateLead(jid, leadData);
      console.log('[LeadData] Guardado:', leadData);
    }

    if (triggers.leadQualified && !lead.tokkoCreado) {
      const leadActual = getLead(jid);
      if (leadActual.canal === 'meta') {
        const resultado = await crearContacto(leadActual);
        if (resultado) updateLead(jid, { tokkoCreado: true, calificado: true });
      } else {
        updateLead(jid, { calificado: true });
      }
    }

    if (triggers.handoff) {
      updateLead(jid, { handoffHecho: true });
      console.log(`[Handoff] Lead ${jid} en manos del asesor`);
    }

  } catch (err) {
    console.error('[Claude] Error:', err.message);
  }
}

// ─── HEALTH CHECK para Railway ────────────────────────────────────────────────

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Vacker Agent — operativo');
}).listen(PORT, () => console.log(`[HTTP] Health check en puerto ${PORT}`));

// ─── ARRANQUE ─────────────────────────────────────────────────────────────────

conectar().then(() => {
  onMessage(procesarMensaje);
  iniciarScheduler(sendMessage);
  console.log('[Agent] Vacker Agent iniciado ✓');
}).catch(err => {
  console.error('[Fatal] No se pudo conectar:', err.message);
  process.exit(1);
});
