// index.js — punto de entrada principal
// Vacker Negocios Inmobiliarios — Agente WhatsApp IA

require('dotenv').config();

// Diagnostico de arranque — antes de cualquier import
console.log('[Config] ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? 'OK' : 'FALTA');
console.log('[Config] TOKKO_API_KEY:', process.env.TOKKO_API_KEY ? 'OK' : 'FALTA');
const path = require('path');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

const { getReply }          = require('./src/claude');
const { addMessage, getLead, updateLead, isActivated } = require('./src/memory');
const { crearContacto, buscarPropiedad, formatearFicha } = require('./src/tokko');
const { iniciarScheduler }  = require('./src/scheduler');
const { ACTIVATION_TRIGGERS } = require('./prompts/vacker');

const SESSION_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'sessions')
  : './sessions';


// ─── FILTRO DE ACTIVACIÓN ────────────────────────────────────────────────────
function esLeadInmobiliario(texto) {
  const t = texto.toLowerCase().trim();
  return ACTIVATION_TRIGGERS.some(trigger => t.includes(trigger));
}

// ─── COMANDO #visita ──────────────────────────────────────────────────────────
// El asesor escribe #visita DD/MM HH:MM en el chat del lead
// Ejemplo: #visita 25/06 18:00
function parseVisitaCommand(texto) {
  const match = texto.match(/^#visita\s+(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/i);
  if (!match) return null;
  const [, dia, mes, hora, min] = match;
  const anio = new Date().getFullYear();
  return new Date(anio, parseInt(mes) - 1, parseInt(dia), parseInt(hora), parseInt(min));
}

// ─── ENVÍO DE MENSAJE ─────────────────────────────────────────────────────────
async function sendMessage(sock, jid, texto) {
  try {
    await sock.sendMessage(jid, { text: texto });
  } catch (err) {
    console.error(`[Send] Error enviando a ${jid}:`, err.message);
  }
}

// ─── CONEXIÓN BAILEYS ─────────────────────────────────────────────────────────
async function conectar() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\n[QR] Escaneá este código con WhatsApp:\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('[Baileys] Conexión cerrada. Reconectando:', shouldReconnect);
      if (shouldReconnect) conectar();
    } else if (connection === 'open') {
      console.log('[Baileys] Conectado ✓');
      iniciarScheduler((jid, texto) => sendMessage(sock, jid, texto));
    }
  });

  // ─── HANDLER DE MENSAJES ────────────────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message) continue;

      const jid     = msg.key.remoteJid;
      const fromMe  = msg.key.fromMe;
      const texto   = msg.message?.conversation
                   || msg.message?.extendedTextMessage?.text
                   || '';

      if (!texto || jid.includes('@g.us')) continue; // ignorar grupos

      // ── Comando del asesor (#visita) ──────────────────────────────────────
      if (fromMe) {
        const fecha = parseVisitaCommand(texto);
        if (fecha) {
          updateLead(jid, { visitaFecha: fecha, reminderEnviado: false, postVisitaEnviado: false });
          const fechaStr = fecha.toLocaleDateString('es-AR', {
            weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit'
          });
          console.log(`[Visita] Programada para ${jid} — ${fechaStr}`);
        }
        continue; // mensajes propios no se procesan por el agente
      }

      // ── Filtro de activación ──────────────────────────────────────────────
      const yaActivado = isActivated(jid);
      if (!yaActivado && !esLeadInmobiliario(texto)) {
        console.log(`[Filtro] Ignorado — no es lead inmobiliario: ${jid}`);
        continue;
      }

      const lead = getLead(jid);
      if (lead.conversacionCerrada) continue;

      // ── Detectar fecha futura mencionada por el lead ──────────────────────
      const meses = texto.match(/(\d+)\s*meses?/i);
      if (meses && !lead.disponibleEn) {
        const fecha = new Date();
        fecha.setMonth(fecha.getMonth() + parseInt(meses[1]));
        updateLead(jid, { disponibleEn: fecha });
        console.log(`[FechaFutura] Lead ${jid} disponible en ${meses[1]} meses`);
      }

      // ── Buscar propiedad en Tokko si el mensaje tiene link o dirección ──────
      let fichaTokko = null;
      if (!lead.propiedadTokkoId) {
        const prop = await buscarPropiedad(texto);
        if (prop) {
          fichaTokko = formatearFicha(prop);
          updateLead(jid, { propiedadTokkoId: prop.id });
          console.log(`[Tokko] Propiedad encontrada: ${prop.id} — ${prop.address}`);
        }
      }

      // ── Llamada a Claude ──────────────────────────────────────────────────
      // Si encontramos la propiedad en Tokko, la incluimos en el mensaje al agente
      const mensajeParaClaude = fichaTokko
        ? `${texto}\n\n[FICHA DE LA PROPIEDAD ENCONTRADA EN TOKKO]\n${fichaTokko}`
        : texto;

      addMessage(jid, 'user', mensajeParaClaude);
      console.log(`[Mensaje] ${jid}: ${texto.substring(0, 60)}...`);

      try {
        const { text: respuesta, triggers } = await getReply(getLead(jid).history);
        addMessage(jid, 'assistant', respuesta);
        await sendMessage(sock, jid, respuesta);

        // ── Procesar triggers ───────────────────────────────────────────────

        // Lead calificado → crear en Tokko
        if (triggers.leadQualified && !lead.tokkoCreado) {
          const resultado = await crearContacto(getLead(jid));
          if (resultado) {
            updateLead(jid, { tokkoCreado: true, calificado: true });
            console.log(`[Tokko] Contacto creado para ${jid}`);
          }
        }

        // Handoff → marcar para no enviar más follow-ups
        if (triggers.handoff) {
          updateLead(jid, { handoffHecho: true });
          console.log(`[Handoff] Lead ${jid} en manos del asesor`);
        }

      } catch (err) {
        console.error('[Claude] Error:', err.message);
      }
    }
  });
}

conectar();
