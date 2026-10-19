// Transporte: Kapso, con coexistencia (Pablo sigue usando la app de WhatsApp
// Business en su teléfono y el agente usa la API sobre el mismo número).
//
// Kapso reenvía tal cual los webhooks de Meta (webhook de tipo "meta"):
//   messages             mensaje que le llega a Pablo        → inbound
//   smb_message_echoes   mensaje que Pablo mandó desde la app → owner
//   smb_app_state_sync   alta o baja en la agenda de Pablo    → agenda
//   history              chats que Pablo ya tenía al conectar → history
//
// Variables: KAPSO_API_KEY, KAPSO_PHONE_NUMBER_ID, KAPSO_WEBHOOK_SECRET.
const crypto = require('crypto');
const { describir, IGNORAR } = require('./meta');

const API = 'https://api.kapso.ai';
const META_VERSION = 'v24.0';

// WHATSAPP_DRY_RUN=1 → no llama a Kapso; loguea y devuelve un id falso.
const dryRun = () => process.env.WHATSAPP_DRY_RUN === '1';
const headers = () => ({ 'X-API-Key': process.env.KAPSO_API_KEY, 'Content-Type': 'application/json' });

async function sendMessage(to, text) {
  const destino = String(to).replace(/\D/g, '');
  if (dryRun()) {
    console.log(`[wa:dry] → ${destino} (${text.length} caracteres)`);
    return { id: `wamid.dry.${crypto.randomUUID()}` };
  }
  const res = await fetch(`${API}/meta/whatsapp/${META_VERSION}/${process.env.KAPSO_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ messaging_product: 'whatsapp', to: destino, type: 'text', text: { body: text } }),
  });
  if (!res.ok) throw new Error(`Kapso ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return { id: json?.messages?.[0]?.id || null };
}

// Firma del webhook: HMAC-SHA256 del cuerpo crudo con el secreto del webhook,
// en hexadecimal, en el header X-Webhook-Signature. Sin secreto solo se acepta en modo prueba.
function verifySignature(rawBody, hdrs) {
  const secreto = process.env.KAPSO_WEBHOOK_SECRET;
  if (!secreto) return dryRun();
  const recibida = String(hdrs['x-webhook-signature'] || '').replace(/^sha256=/, '');
  if (!recibida) return false;
  const esperada = Buffer.from(crypto.createHmac('sha256', secreto).update(rawBody).digest('hex'));
  const b = Buffer.from(recibida);
  return esperada.length === b.length && crypto.timingSafeEqual(esperada, b);
}

function cambios(payload) {
  if (Array.isArray(payload.entry)) return payload.entry.flatMap((e) => e.changes || []);
  if (payload.field && payload.value) return [payload];
  return [];
}

// Traduce el payload a eventos del core.
function parseWebhook(payload) {
  const eventos = [];
  for (const { field, value = {} } of cambios(payload)) {
    if (field === 'messages') {
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
    } else if (field === 'smb_message_echoes') {
      for (const eco of value.message_echoes || []) {
        if (!eco.to) continue;
        eventos.push({ kind: 'owner', evento: { to: eco.to, text: eco.type === 'text' ? eco.text?.body || null : null, messageId: eco.id } });
      }
    } else if (field === 'smb_app_state_sync') {
      const lista = (value.state_sync || [])
        .filter((s) => s.type === 'contact' && s.contact?.phone_number && ['add', 'remove'].includes(s.action))
        .map((s) => ({ numero: s.contact.phone_number, accion: s.action }));
      if (lista.length) eventos.push({ kind: 'agenda', cambios: lista });
    } else if (field === 'history') {
      const numeros = (value.history || []).flatMap((h) => (h.threads || []).map((t) => t.id)).filter(Boolean);
      if (numeros.length) eventos.push({ kind: 'history', numeros });
    }
  }
  return eventos;
}

// Agenda completa: los contactos que Kapso importó del teléfono de Pablo
// (marcados con metadata.synced_from_business_app). Ojo: la lista es de todo el
// proyecto de Kapso; el número de Pablo tiene que estar solo en su proyecto.
async function cargarAgenda() {
  const numeros = [];
  let after = null;
  for (let pagina = 0; pagina < 1000; pagina += 1) {
    const url = new URL(`${API}/platform/v1/whatsapp/contacts`);
    url.searchParams.set('limit', '100');
    if (after) url.searchParams.set('after', after);
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) throw new Error(`Kapso contactos ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    for (const c of json.data || []) {
      if (c.wa_id && c.metadata?.synced_from_business_app) numeros.push(c.wa_id);
    }
    after = json.paging?.cursors?.after || null;
    if (!after || (json.data || []).length < 100) return numeros;
  }
  throw new Error('demasiadas páginas de contactos');
}

module.exports = { nombre: 'kapso', ruta: '/webhook', sendMessage, verifySignature, parseWebhook, cargarAgenda };
