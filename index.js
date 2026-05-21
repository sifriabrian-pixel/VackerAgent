// index.js — punto de entrada principal
// Vacker Negocios Inmobiliarios — Agente WhatsApp IA

require('dotenv').config();

// Diagnostico de arranque
console.log('[Config] ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? 'OK' : 'FALTA');
console.log('[Config] TOKKO_API_KEY:', process.env.TOKKO_API_KEY ? 'OK' : 'FALTA');

const path = require('path');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const http = require('http');
const QRCode = require('qrcode');

const { getReply }          = require('./src/claude');
const { addMessage, getLead, updateLead, isActivated } = require('./src/memory');
const { crearContacto, buscarPropiedad, formatearFicha } = require('./src/tokko');
const { iniciarScheduler }  = require('./src/scheduler');
const { ACTIVATION_TRIGGERS } = require('./prompts/vacker');

const SESSION_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? process.env.RAILWAY_VOLUME_MOUNT_PATH
  : './sessions';

console.log('[Config] SESSION_PATH:', SESSION_PATH);

// ─── SERVIDOR HTTP PARA VER EL QR ────────────────────────────────────────────
let currentQR = null;
const PORT = process.env.PORT || 3000;

http.createServer(async (req, res) => {
  if (currentQR) {
    try {
      const qrImage = await QRCode.toDataURL(currentQR);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Vacker — Conectar WhatsApp</title>
  <style>
    body { font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #0d1117; color: #fff; }
    h2 { color: #c9a84c; margin-bottom: 8px; }
    p { color: #888; margin-bottom: 24px; font-size: 14px; }
    img { border: 4px solid #c9a84c; border-radius: 12px; width: 280px; }
    .dot { width: 10px; height: 10px; background: #25D366; border-radius: 50%; display: inline-block; margin-right: 8px; animation: pulse 1.5s infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
  </style>
  <meta http-equiv="refresh" content="30">
</head>
<body>
  <h2>Vacker — Agente WhatsApp</h2>
  <p><span class="dot"></span>Escaneá con WhatsApp → Dispositivos vinculados</p>
  <img src="${qrImage}" alt="QR Code"/>
  <p style="margin-top:16px;font-size:12px">La página se actualiza cada 30 segundos</p>
</body>
</html>`);
    } catch (e) {
      res.writeHead(500); res.end('Error generando QR');
    }
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Vacker — WhatsApp</title>
  <style>body{font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0d1117;color:#fff;} h2{color:#c9a84c;} p{color:#888;}</style>
  <meta http-equiv="refresh" content="5">
</head>
<body>
  <h2>Vacker — Agente WhatsApp</h2>
  <p>✓ Conectado y operativo</p>
</body>
</html>`);
  }
}).listen(PORT, () => {
  console.log('[HTTP] Servidor QR corriendo en puerto', PORT);
});

// ─── FILTRO DE ACTIVACIÓN ─────────────────────────────────────────────────────
function esLeadInmobiliario(texto) {
  const t = texto.toLowerCase().trim();
  return ACTIVATION_TRIGGERS.some(trigger => t.includes(trigger));
}

// ─── COMANDO #visita ──────────────────────────────────────────────────────────
function parseVisitaCommand(texto) {
  const match = texto.match(/^#visita\s+(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/i);
  if (!match) return null;
  const [, dia, mes, hora, min] = match;
  return new Date(new Date().getFullYear(), parseInt(mes) - 1, parseInt(dia), parseInt(hora), parseInt(min));
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
  console.log('[Conectar] Iniciando, SESSION_PATH:', SESSION_PATH);

  let state, saveCreds;
  try {
    const auth = await useMultiFileAuthState(SESSION_PATH);
    state = auth.state;
    saveCreds = auth.saveCreds;
    console.log('[Conectar] Auth state cargado OK');
  } catch (err) {
    console.error('[Conectar] Error cargando auth state:', err.message);
    setTimeout(conectar, 5000);
    return;
  }

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      currentQR = qr;
      console.log('[QR] Código generado — abrí el dominio en Railway para escanearlo');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('[Baileys] Conexión cerrada. Reconectando:', shouldReconnect);
      if (shouldReconnect) conectar();
    } else if (connection === 'open') {
      currentQR = null;
      console.log('[Baileys] Conectado ✓');
      iniciarScheduler((jid, texto) => sendMessage(sock, jid, texto));
    }
  });

  // ─── HANDLER DE MENSAJES ──────────────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message) continue;

      const jid    = msg.key.remoteJid;
      const fromMe = msg.key.fromMe;
      const texto  = msg.message?.conversation
                  || msg.message?.extendedTextMessage?.text
                  || '';

      if (!texto || jid.includes('@g.us')) continue;

      // Comando del asesor (#visita)
      if (fromMe) {
        const fecha = parseVisitaCommand(texto);
        if (fecha) {
          updateLead(jid, { visitaFecha: fecha, reminderEnviado: false, postVisitaEnviado: false });
          console.log(`[Visita] Programada para ${jid} — ${fecha.toLocaleString('es-AR')}`);
        }
        continue;
      }

      // Filtro de activación
      const yaActivado = isActivated(jid);
      if (!yaActivado && !esLeadInmobiliario(texto)) {
        console.log(`[Filtro] Ignorado: ${jid}`);
        continue;
      }

      const lead = getLead(jid);
      if (lead.conversacionCerrada) continue;

      // Detectar fecha futura
      const meses = texto.match(/(\d+)\s*meses?/i);
      if (meses && !lead.disponibleEn) {
        const fecha = new Date();
        fecha.setMonth(fecha.getMonth() + parseInt(meses[1]));
        updateLead(jid, { disponibleEn: fecha });
        console.log(`[FechaFutura] Lead ${jid} disponible en ${meses[1]} meses`);
      }

      // Buscar propiedad en Tokko
      let fichaTokko = null;
      if (!lead.propiedadTokkoId) {
        const prop = await buscarPropiedad(texto);
        if (prop) {
          fichaTokko = formatearFicha(prop);
          updateLead(jid, { propiedadTokkoId: prop.id });
          console.log(`[Tokko] Propiedad encontrada: ${prop.id} — ${prop.address}`);
        }
      }

      // Llamada a Claude
      const mensajeParaClaude = fichaTokko
        ? `${texto}\n\n[FICHA DE LA PROPIEDAD ENCONTRADA EN TOKKO]\n${fichaTokko}`
        : texto;

      addMessage(jid, 'user', mensajeParaClaude);
      console.log(`[Mensaje] ${jid}: ${texto.substring(0, 60)}`);

      try {
        const { text: respuesta, triggers } = await getReply(getLead(jid).history);
        addMessage(jid, 'assistant', respuesta);
        await sendMessage(sock, jid, respuesta);

        if (triggers.leadQualified && !lead.tokkoCreado) {
          const resultado = await crearContacto(getLead(jid));
          if (resultado) {
            updateLead(jid, { tokkoCreado: true, calificado: true });
            console.log(`[Tokko] Contacto creado para ${jid}`);
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
  });
}

conectar();
