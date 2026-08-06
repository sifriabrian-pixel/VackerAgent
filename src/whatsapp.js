// whatsapp.js — conexión Baileys (WhatsApp Business de Ezequiel)

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const NodeCache = require('node-cache');
const path = require('path');
const fs = require('fs');

const AUTH_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'baileys_auth')
  : path.join(__dirname, '..', 'baileys_auth');

// Estos DEBEN estar fuera del bucle de reconexión
const msgRetryCounterCache = new NodeCache();
const messageStore = new Map();
const jidSendMap = new Map(); // phone@s.whatsapp.net → lid@lid

let sock = null;
let onMessageCallback = null;
let currentQR = null;
let reconnectCount = 0;
let lastReconnectTime = 0;
let waVersion = null;
let reconnectTimer = null; // evita múltiples reconexiones simultáneas

function getQR() { return currentQR; }

function onMessage(callback) {
  onMessageCallback = callback;
}

async function conectar() {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  if (!waVersion) {
    const { version } = await fetchLatestBaileysVersion();
    waVersion = version;
    console.log('[WhatsApp] Versión WA:', waVersion.join('.'));
  }

  const logger = pino({ level: 'warn' });

  sock = makeWASocket({
    version: waVersion,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    msgRetryCounterCache,
    logger,
    browser: Browsers.windows('Edge'),
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    getMessage: async (key) => {
      const stored = messageStore.get(key.id);
      return stored?.message || undefined;
    },
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

      const scheduleReconexion = (ms) => {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => { reconnectTimer = null; conectar(); }, ms);
      };

      if (!shouldReconnect) {
        console.log('[WhatsApp] Sesión expirada. Borrando credenciales y generando QR...');
        reconnectCount = 0;
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        scheduleReconexion(2000);
      } else if (code === 440) {
        const ahora = Date.now();
        reconnectCount = (ahora - lastReconnectTime < 30000) ? reconnectCount + 1 : 1;
        lastReconnectTime = ahora;

        if (reconnectCount >= 5) {
          console.log('[WhatsApp] Demasiados 440 seguidos — deteniendo. Usá /reset-session para reiniciar.');
          reconnectCount = 0;
        } else {
          console.log(`[WhatsApp] 440 replaced (${reconnectCount}/5) — reconectando en 10s...`);
          scheduleReconexion(10000);
        }
      } else {
        scheduleReconexion(5000);
      }
    }

    if (connection === 'open') {
      currentQR = null;
      console.log('[WhatsApp] Conectado al WhatsApp de Ezequiel ✓');
    }
  });

  sock.ev.on('messages.update', updates => {
    for (const update of updates) {
      if (update.key.fromMe) {
        console.log(`[STATUS] msg ${update.key.id} → status: ${update.update?.status}`);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // Guardar todos los mensajes para getMessage (retry de Signal Protocol)
    for (const msg of messages) {
      if (msg.key?.id) messageStore.set(msg.key.id, msg);
    }

    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;

      const rawJid = msg.key.remoteJid;
      if (!rawJid || rawJid.endsWith('@g.us')) continue;

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

async function sendMessage(phoneJid, texto) {
  if (!sock) {
    console.error('[WhatsApp] Socket no inicializado');
    return;
  }
  const sendJid = jidSendMap.get(phoneJid) || phoneJid;
  try {
    await sock.presenceSubscribe(sendJid);
    await new Promise(r => setTimeout(r, 800));
    await sock.sendPresenceUpdate('composing', sendJid);
    await new Promise(r => setTimeout(r, 1500));
    const result = await sock.sendMessage(sendJid, { text: texto, linkPreview: false });
    if (result?.key?.id) messageStore.set(result.key.id, result);
    await sock.sendPresenceUpdate('paused', sendJid);
    console.log(`[Msg OUT] ${phoneJid} via ${sendJid}: ${texto.substring(0, 60)}`);
    console.log(`[Msg ID] ${result?.key?.id}`);
  } catch (err) {
    console.error('[ERROR sendMessage]', err.message, err.stack?.split('\n')[1]);
  }
}

async function resetSession() {
  console.log('[WhatsApp] Reset manual — borrando sesión...');
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (sock) {
    try { sock.end(); } catch (_) {}
    sock = null;
  }
  currentQR = null;
  reconnectCount = 0;
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  setTimeout(() => conectar(), 1500);
}

module.exports = { conectar, sendMessage, onMessage, getQR, resetSession };
