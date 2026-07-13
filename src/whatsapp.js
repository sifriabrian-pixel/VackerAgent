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
const jidSendMap = new Map(); // phone@s.whatsapp.net → lid@lid para enrutamiento

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

      // @lid es el JID de enrutamiento multidevice — guardarlo para enviar
      // pero usar senderPn (número real) para memoria/tracking
      const jid = rawJid.endsWith('@lid') && msg.key.senderPn
        ? msg.key.senderPn
        : rawJid;
      if (rawJid.endsWith('@lid') && msg.key.senderPn) {
        jidSendMap.set(msg.key.senderPn, rawJid);
      }

      const texto = msg.message.conversation
        || msg.message.extendedTextMessage?.text
        || '';

      if (!texto.trim()) continue;

      const sendJid = jidSendMap.get(jid) || jid;
      console.log(`[Msg IN] ${jid} (sendJid: ${sendJid}): ${texto.substring(0, 60)}`);

      if (onMessageCallback) {
        try {
          await onMessageCallback(jid, texto, sendJid);
        } catch (err) {
          console.error('[WhatsApp] Error procesando mensaje:', err.message);
        }
      }
    }
  });

  return sock;
}

async function sendMessage(phoneJid, texto) {
  if (!sock) {
    console.error('[WhatsApp] Socket no inicializado');
    return;
  }
  // Usar @lid para enrutamiento multidevice si está disponible
  const sendJid = jidSendMap.get(phoneJid) || phoneJid;
  try {
    await sock.assertSessions([sendJid]);
    await sock.presenceSubscribe(sendJid);
    await new Promise(r => setTimeout(r, 800));
    await sock.sendPresenceUpdate('composing', sendJid);
    await new Promise(r => setTimeout(r, 1500));
    const result = await sock.sendMessage(sendJid, { text: texto });
    await sock.sendPresenceUpdate('paused', sendJid);
    console.log(`[Msg OUT] ${phoneJid} via ${sendJid}: ${texto.substring(0, 60)}`);
    console.log(`[Msg ID] ${result?.key?.id}`);
  } catch (err) {
    console.error('[ERROR sendMessage]', err.message, err.stack?.split('\n')[1]);
  }
}

module.exports = { conectar, sendMessage, onMessage, getQR };
