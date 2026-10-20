// Transporte Kapso: firma del webhook y traducción de los eventos de coexistencia.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
require('./helpers');
const kapso = require('../src/adapters/kapso');

const envolver = (field, value) => ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field, value }] }] });

test('firma: HMAC-SHA256 en hex con el secreto del webhook', () => {
  const body = Buffer.from('{"a":1}');
  process.env.KAPSO_WEBHOOK_SECRET = 'k5';
  try {
    const firma = crypto.createHmac('sha256', 'k5').update(body).digest('hex');
    assert.equal(kapso.verifySignature(body, { 'x-webhook-signature': firma }), true);
    assert.equal(kapso.verifySignature(body, { 'x-webhook-signature': 'mala' }), false);
    assert.equal(kapso.verifySignature(body, {}), false);
  } finally { delete process.env.KAPSO_WEBHOOK_SECRET; }
});

test('mensaje entrante, eco de Pablo, agenda e historial', () => {
  const entrante = kapso.parseWebhook(envolver('messages', {
    contacts: [{ wa_id: '5493415550001', profile: { name: 'Caro' } }],
    messages: [{ from: '5493415550001', id: 'wamid.1', type: 'text', text: { body: 'Hola' }, referral: { source_type: 'ad', headline: 'Casa' } }],
  }));
  assert.deepEqual(entrante[0].input, { conversationId: '5493415550001', from: '5493415550001', text: 'Hola', messageId: 'wamid.1', type: 'text', metadata: { referral: { source_type: 'ad', headline: 'Casa' }, profileName: 'Caro' } });

  assert.deepEqual(kapso.parseWebhook(envolver('smb_message_echoes', {
    message_echoes: [{ from: '5493410000000', to: '5493415550001', id: 'wamid.2', type: 'text', text: { body: 'Te llamo' } }],
  })), [{ kind: 'owner', evento: { to: '5493415550001', text: 'Te llamo', messageId: 'wamid.2' } }]);

  assert.deepEqual(kapso.parseWebhook(envolver('smb_app_state_sync', {
    state_sync: [
      { type: 'contact', contact: { full_name: 'Mamá', phone_number: '5493415550002' }, action: 'add' },
      { type: 'contact', contact: { phone_number: '5493415550003' }, action: 'remove' },
    ],
  })), [{ kind: 'agenda', cambios: [{ numero: '5493415550002', accion: 'add' }, { numero: '5493415550003', accion: 'remove' }] }]);

  assert.deepEqual(kapso.parseWebhook(envolver('history', {
    history: [{ metadata: { phase: 0 }, threads: [{ id: '5493415550004', messages: [] }, { id: '5493415550005', messages: [] }] }],
  })), [{ kind: 'history', numeros: ['5493415550004', '5493415550005'] }]);

  assert.deepEqual(kapso.parseWebhook(envolver('history', { history: [{ errors: [{ code: 2593109 }] }] })), []);
  assert.deepEqual(kapso.parseWebhook(envolver('messages', { statuses: [{ id: 'wamid.1', status: 'read' }] })), []);
});

test('agenda inicial: solo los contactos importados del teléfono, todas las páginas', async () => {
  const original = global.fetch;
  const pedidos = [];
  const pagina = (desde, n) => Array.from({ length: n }, (_, i) => ({ wa_id: String(5493415550000 + desde + i), metadata: { synced_from_business_app: (desde + i) % 2 === 0 } }));
  global.fetch = async (url) => {
    pedidos.push(String(url));
    const after = new URL(url).searchParams.get('after');
    const body = after ? { data: pagina(100, 3), paging: { cursors: { after: 'c2' } } } : { data: pagina(0, 100), paging: { cursors: { after: 'c1' }, next: 'x' } };
    return { ok: true, json: async () => body };
  };
  try {
    const numeros = await kapso.cargarAgenda();
    assert.equal(pedidos.length, 2);
    assert.equal(numeros.length, 50 + 2);
  } finally { global.fetch = original; }
});
