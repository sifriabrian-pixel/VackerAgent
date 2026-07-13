// whatsapp.js — conexión Baileys (WhatsApp Business de Ezequiel)

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, proto } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');

// Guardar sesión en el volumen de Railway si existe, sino local
const AUTH_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'baileys_auth')
  : path.join(__dirname, '..', 'baileys_auth');

let sock = null;
let onMessageCallback = null;
let currentQR = null;

function getQR() { return currentQR; }

function onMessage(callback) {
  onMessageCallback = callback;
}

async function conectar() {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const { version } = await fetchLatestBaileysVersion();
  console.log('[WhatsApp] Versión WA:', version.join('.'));

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['VackerAgent', 'Chrome', '110.0.0'],
    getMessage: async () => ({ conversation: '' }),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      currentQR = qr;
      console.log('\n[WhatsApp] *** QR listo — abrí /qr en el dominio de Railway ***\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log('[WhatsApp] Conexión cerrada. Código:', code, '| Reconectando:', shouldReconnect);
      if (shouldReconnect) setTimeout(conectar, 3000);
    }

    if (connection === 'open') {
      currentQR = null;
      console.log('[WhatsApp] Conectado al WhatsApp de Ezequiel ✓');
    }
  });

  // Monitorear estado de entrega de mensajes enviados
  sock.ev.on('messages.update', updates => {
    for (const update of updates) {
      if (update.key.fromMe) {
        console.log(`[STATUS] msg ${update.key.id} → status: ${update.update?.status}`);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;

      const rawJid = msg.key.remoteJid;
      if (!rawJid || rawJid.endsWith('@g.us')) continue; // ignorar grupos

      // @lid es un ID interno — usar senderPn que tiene el número real
      const jid = rawJid.endsWith('@lid') && msg.key.senderPn
        ? msg.key.senderPn
        : rawJid;

      const texto = msg.message.conversation
        || msg.message.extendedTextMessage?.text
        || '';

      if (!texto.trim()) continue;

      console.log(`[Msg IN] ${jid}: ${texto.substring(0, 60)}`);
      console.log(`[Key DEBUG] ${JSON.stringify(msg.key)}`);

      if (onMessageCallback) {
        try {
          await onMessageCallback(jid, texto);
        } catch (err) {
          console.error('[WhatsApp] Error procesando mensaje:', err.message);
        }
      }
    }
  });

  return sock;
}

async function sendMessage(jid, texto) {
  if (!sock) {
    console.error('[WhatsApp] Socket no inicializado');
    return;
  }
  try {
    // Forzar establecimiento de claves Signal antes de enviar
    await sock.assertSessions([jid]);
    await sock.presenceSubscribe(jid);
    await new Promise(r => setTimeout(r, 800));
    await sock.sendPresenceUpdate('composing', jid);
    await new Promise(r => setTimeout(r, 1500));
    const result = await sock.sendMessage(jid, { text: texto });
    await sock.sendPresenceUpdate('paused', jid);
    console.log(`[Msg OUT] ${jid}: ${texto.substring(0, 60)}`);
    console.log(`[Msg ID] ${result?.key?.id}`);
  } catch (err) {
    console.error('[ERROR sendMessage]', err.message, err.stack?.split('\n')[1]);
  }
}

module.exports = { conectar, sendMessage, onMessage, getQR };
