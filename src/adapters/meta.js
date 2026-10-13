// Transporte: WhatsApp Cloud API de Meta (número de prueba). Sin coexistencia:
// no informa los mensajes que el asesor manda desde su teléfono.
const crypto = require('crypto');

const GRAPH_VERSION = 'v21.0';

// WHATSAPP_DRY_RUN=1 → no llama a Meta; loguea y devuelve un id falso.
const dryRun = () => process.env.WHATSAPP_DRY_RUN === '1';

// Los celulares de Argentina llegan con un 9 extra (549…) que Meta no acepta
// como destinatario en la lista de permitidos. Se envía sin ese dígito.
function normalizeTo(to) {
  const n = String(to).replace(/\D/g, '');
  return /^549\d{10}$/.test(n) ? `54${n.slice(3)}` : n;
}

async function sendMessage(to, text) {
  const destino = normalizeTo(to);
  if (dryRun()) {
    console.log(`[wa:dry] → ${destino} (${text.length} caracteres)`);
    return { id: `wamid.dry.${crypto.randomUUID()}` };
  }
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: destino, type: 'text', text: { body: text } }),
  });
  if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return { id: json?.messages?.[0]?.id || null };
}

// Firma HMAC del webhook con el App Secret. Sin App Secret solo se acepta en modo prueba.
function verifySignature(rawBody, headers) {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) return dryRun();
  const recibida = headers['x-hub-signature-256'];
  if (!recibida) return false;
  const esperada = Buffer.from('sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex'));
  const b = Buffer.from(recibida);
  return esperada.length === b.length && crypto.timingSafeEqual(esperada, b);
}

function describir(msg) {
  switch (msg.type) {
    case 'text': return msg.text?.body || '';
    case 'button': return msg.button?.text || '[Tocó un botón]';
    case 'interactive': return msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '[Respondió un mensaje interactivo]';
    case 'image': return `[Envió una imagen${msg.image?.caption ? `: ${msg.image.caption}` : ''}]`;
    case 'document': return '[Envió un documento]';
    case 'audio': return '[Envió un audio que no se puede escuchar]';
    case 'video': return '[Envió un video que no se puede ver]';
    case 'sticker': return '[Envió un sticker]';
    case 'location': return '[Envió una ubicación]';
    default: return `[Envió un mensaje de tipo ${msg.type}]`;
  }
}

const IGNORAR = new Set(['reaction', 'system', 'ephemeral']);

// Traduce el payload del webhook de Meta a eventos del core.
function parseWebhook(payload) {
  const eventos = [];
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const perfiles = Object.fromEntries((value.contacts || []).map((c) => [c.wa_id, c.profile?.name || null]));
      for (const msg of value.messages || []) {
        if (!msg.from || IGNORAR.has(msg.type)) continue;
        eventos.push({
          kind: 'inbound',
          input: {
            conversationId: msg.from, from: msg.from, text: describir(msg), messageId: msg.id, type: msg.type,
            metadata: { referral: msg.referral || null, profileName: perfiles[msg.from] || null },
          },
        });
      }
    }
  }
  return eventos;
}

module.exports = { nombre: 'meta', ruta: '/webhook', sendMessage, verifySignature, parseWebhook, normalizeTo };
