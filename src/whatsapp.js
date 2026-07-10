// whatsapp.js — conexión Baileys (WhatsApp Business de Ezequiel)

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

// Guardar sesión en el volumen de Railway si existe, sino local
const AUTH_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'baileys_auth')
  : path.join(__dirname, '..', 'baileys_auth');

let sock = null;
let onMessageCallback = null;

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
    printQRInTerminal: true,
    browser: ['VackerAgent', 'Chrome', '110.0.0'],
    getMessage: async () => ({ conversation: '' }),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\n[WhatsApp] *** Escaneá este QR con el celular de Ezequiel ***\n');
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log('[WhatsApp] Conexión cerrada. Código:', code, '| Reconectando:', shouldReconnect);
      if (shouldReconnect) setTimeout(conectar, 3000);
    }

    if (connection === 'open') {
      console.log('[WhatsApp] Conectado al WhatsApp de Ezequiel ✓');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;

      const jid = msg.key.remoteJid;
      if (!jid || jid.endsWith('@g.us')) continue; // ignorar grupos

      const texto = msg.message.conversation
        || msg.message.extendedTextMessage?.text
        || '';

      if (!texto.trim()) continue;

      console.log(`[Msg IN] ${jid}: ${texto.substring(0, 60)}`);

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
  await sock.sendMessage(jid, { text: texto });
  console.log(`[Msg OUT] ${jid}: ${texto.substring(0, 60)}`);
}

module.exports = { conectar, sendMessage, onMessage };
