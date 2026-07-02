// index.js — Vacker Negocios Inmobiliarios — Agente WhatsApp IA (Meta Cloud API)

require('dotenv').config();

console.log('[Config] ANTHROPIC_API_KEY:',  process.env.ANTHROPIC_API_KEY  ? 'OK' : 'FALTA');
console.log('[Config] TOKKO_API_KEY:',       process.env.TOKKO_API_KEY       ? 'OK' : 'FALTA');
console.log('[Config] WHATSAPP_TOKEN:',      process.env.WHATSAPP_TOKEN      ? 'OK' : 'FALTA');
console.log('[Config] PHONE_NUMBER_ID:',     process.env.PHONE_NUMBER_ID     ? 'OK' : 'FALTA');
console.log('[Config] WEBHOOK_VERIFY_TOKEN:', process.env.WEBHOOK_VERIFY_TOKEN ? 'OK' : 'FALTA');

const http = require('http');

const { getReply }                                              = require('./src/claude');
const { addMessage, getLead, updateLead, isActivated }         = require('./src/memory');
const { buscarPropiedad, formatearFicha, crearContacto }       = require('./src/tokko');
const { iniciarScheduler }                                     = require('./src/scheduler');
const { sendMessage }                                          = require('./src/whatsapp');
const { ACTIVATION_TRIGGERS, META_TRIGGERS }                   = require('./prompts/vacker');

const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const PORT         = process.env.PORT || 3000;

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function esLeadInmobiliario(texto) {
  const t = texto.toLowerCase().trim();
  return ACTIVATION_TRIGGERS.some(trigger => t.includes(trigger));
}

function esCanaMeta(texto) {
  const t = texto.toLowerCase().trim();
  return META_TRIGGERS.some(trigger => t.includes(trigger));
}

// ─── PROCESAMIENTO DE MENSAJE ─────────────────────────────────────────────────

async function procesarMensaje(phone, texto) {
  const jid = phone;

  const yaActivado = isActivated(jid);
  if (!yaActivado && !esLeadInmobiliario(texto)) {
    console.log(`[Filtro] Ignorado: ${jid}`);
    return;
  }

  const lead = getLead(jid);
  if (lead.conversacionCerrada) return;
  if (lead.asesorIntervino) {
    console.log(`[Filtro] Agente pausado por asesor en: ${jid}`);
    return;
  }

  // Canal de origen
  if (!lead.canal) {
    updateLead(jid, { canal: esCanaMeta(texto) ? 'meta' : 'portal' });
  }

  // Fecha futura de disponibilidad
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
      console.log(`[LeadData] Guardado:`, leadData);
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

// ─── PROCESAMIENTO DE WEBHOOK ─────────────────────────────────────────────────

async function procesarWebhook(data) {
  if (data.object !== 'whatsapp_business_account') return;

  for (const entry of data.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'messages') continue;

      const messages = change.value?.messages || [];
      for (const msg of messages) {
        if (msg.type !== 'text') continue;
        const texto = msg.text?.body || '';
        if (!texto) continue;
        await procesarMensaje(msg.from, texto);
      }
    }
  }
}

// ─── SERVIDOR HTTP ────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost`);

  // GET /webhook — verificación de Meta
  if (req.method === 'GET' && url.pathname === '/webhook') {
    const mode      = url.searchParams.get('hub.mode');
    const token     = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('[Webhook] Verificación OK');
      res.writeHead(200);
      res.end(challenge);
    } else {
      res.writeHead(403);
      res.end('Forbidden');
    }
    return;
  }

  // POST /webhook — mensajes entrantes
  if (req.method === 'POST' && url.pathname === '/webhook') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      // Meta requiere 200 inmediato, antes de procesar
      res.writeHead(200);
      res.end('OK');
      try {
        await procesarWebhook(JSON.parse(body));
      } catch (err) {
        console.error('[Webhook] Error procesando payload:', err.message);
      }
    });
    return;
  }

  // Health check
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Vacker Agent — operativo');
});

server.listen(PORT, () => {
  console.log(`[HTTP] Servidor corriendo en puerto ${PORT}`);
  iniciarScheduler(sendMessage);
});
