// Adapter de WhatsApp y servidor: cola por número, envío, acciones y endpoints.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const h = require('./helpers');

const repo = require('../src/repo');
const agent = require('../src/agent');
const llm = require('../src/llm');
const tokko = require('../src/tokko');
const meta = require('../src/adapters/meta');
const { startServer } = require('../index');

// Claude falso con la forma del SDK (el adapter usa el llm real del core).
function fakeClaude(responder) {
  const calls = [];
  llm.setClient({ messages: { create: async (params) => { calls.push(params); return { content: [{ type: 'text', text: await responder(params, calls.length) }] }; } } });
  return calls;
}

function fakeProvider() {
  const sent = [];
  agent.setProvider({ sendMessage: async (to, text) => { sent.push({ to, text }); return { id: `wamid.out.${sent.length}` }; } });
  return sent;
}

const inbound = (num, text, extra = {}) => ({ kind: 'inbound', input: { ...h.msg(num, text), messageId: `in.${Math.random()}`, ...extra } });

test.beforeEach(() => { process.env.MODO_OBSERVACION = 'false'; });

test('flujo completo: llega un lead con link, el agente responde y queda registrado como enviado', async () => {
  h.tmpDb();
  const sent = fakeProvider();
  const calls = fakeClaude(() => 'Hola! Te paso la info. [PROPIEDAD:VHO9477038]');
  const num = h.numero();
  agent.handleEvents([inbound(num, `Hola ${h.LINK_ZP}`)]);
  await agent.idle();
  assert.deepEqual(sent, [{ to: num, text: 'Hola! Te paso la info.' }]);
  assert.equal(calls[0].system[0].cache_control.type, 'ephemeral');
  assert.equal(h.db.get().prepare("SELECT estado FROM mensajes WHERE direccion = 'out'").get().estado, 'enviado');
  assert.ok(repo.getLead(num).ultimo_agente_at);
});

test('por defecto arranca en modo observación: no llama a Claude ni envía nada', async () => {
  delete process.env.MODO_OBSERVACION;
  h.tmpDb();
  const sent = fakeProvider();
  const calls = fakeClaude(() => 'x');
  agent.handleEvents([inbound(h.numero(), `Hola ${h.LINK_ZP}`)]);
  await agent.idle();
  assert.equal(sent.length + calls.length, 0);
});

test('dos mensajes seguidos: una sola respuesta que contempla ambos', async () => {
  h.tmpDb();
  const sent = fakeProvider();
  const calls = fakeClaude(async (p, n) => { await h.dormir(40); return `respuesta ${n}`; });
  const num = h.numero();
  agent.handleEvents([inbound(num, `Hola ${h.LINK_ZP}`)]);
  await h.dormir(10); // Claude ya está respondiendo el primero
  agent.handleEvents([inbound(num, 'busco 2 dormitorios')]);
  await agent.idle();
  assert.equal(sent.length, 1);
  assert.match(calls[calls.length - 1].messages[0].content, /busco 2 dormitorios/);
});

test('contacto personal y mensajes del asesor: nada llega a Claude ni se envía', async () => {
  h.tmpDb();
  const sent = fakeProvider();
  const calls = fakeClaude(() => 'x');
  const amigo = h.numero();
  agent.handleEvents([{ kind: 'owner', evento: { to: amigo, text: 'nos vemos mañana', messageId: 'o1' } }]);
  agent.handleEvents([inbound(amigo, `mirá ${h.LINK_ZP}`), inbound(h.numero(), 'Hola, una consulta')]);
  agent.handleEvents([{ kind: 'history', numeros: [h.numero()] }]);
  await agent.idle();
  assert.equal(sent.length + calls.length, 0);
  assert.equal(repo.leads().length, 0);
});

test('pendiente resuelto como lead desde el panel: el agente le responde', async () => {
  h.tmpDb();
  const sent = fakeProvider();
  fakeClaude(() => 'Hola! ¿Por cuál propiedad me escribís?');
  const num = h.numero();
  agent.handleEvents([inbound(num, 'Hola, sigue disponible?')]);
  await agent.idle();
  assert.equal(sent.length, 0);
  assert.deepEqual(agent.resolver(num, 'lead'), { ok: true, liberados: 1 });
  await agent.idle();
  assert.equal(sent.length, 1);
});

test('si Claude falla se reintenta y al tercer error se manda una disculpa', async () => {
  h.tmpDb();
  const sent = fakeProvider();
  const calls = fakeClaude(async () => { throw new Error('529 overloaded'); });
  const num = h.numero();
  const errores = console.error; console.error = () => {};
  try {
    agent.handleEvents([inbound(num, `Hola ${h.LINK_ZP}`)]);
    for (let i = 0; i < 30 && !sent.length; i++) { await agent.idle(); await h.dormir(40); }
  } finally { console.error = errores; }
  assert.equal(calls.length, 3);
  assert.match(sent[0].text, /problema técnico/);
});

test('lead de anuncio derivado: se carga en Tokko una vez; si Tokko falla queda registrado', async () => {
  const original = tokko.crearContacto;
  const errores = console.error; console.error = () => {};
  try {
    for (const falla of [false, true]) {
      h.tmpDb();
      fakeProvider();
      const cargados = [];
      tokko.crearContacto = async (p) => { if (falla) throw new Error('Tokko 500'); cargados.push(p); };
      fakeClaude(() => 'Te escribo en breve. [NOMBRE:Ana] [PROPIEDAD:VHO9477038] [DISPONIBILIDAD:jueves] [HANDOFF_AGENDA]');
      const num = h.numero();
      agent.handleEvents([inbound(num, 'Quiero visitarla', { metadata: { referral: h.ANUNCIO } })]);
      await agent.idle();
      agent.handleEvents([inbound(num, 'gracias')]);
      await agent.idle();
      const tipos = repo.events(num).map((e) => e.tipo);
      if (falla) {
        assert.equal(tipos.filter((t) => t === 'tokko_fallido').length, 1);
        assert.equal(repo.getLead(num).tokko_at, null);
      } else {
        assert.equal(cargados.length, 1);
        assert.equal(cargados[0].name, 'Ana');
        assert.ok(repo.getLead(num).tokko_at);
      }
    }
  } finally { tokko.crearContacto = original; console.error = errores; }
});

test('servidor: /health abierto, /api solo con el token por header, webhook solo con firma válida', async () => {
  h.tmpDb();
  fakeProvider();
  fakeClaude(() => 'Hola');
  process.env.PORT = '0';
  const server = startServer(meta);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const errores = console.error; console.error = () => {};
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);

    // Sin ADMIN_TOKEN configurado no entra nadie.
    assert.equal((await fetch(`${base}/api/leads`)).status, 401);
    assert.equal((await fetch(`${base}/api/leads`, { headers: { Authorization: 'Bearer ' } })).status, 401);
    process.env.ADMIN_TOKEN = 'secreto';
    assert.equal((await fetch(`${base}/api/leads`)).status, 401);
    assert.equal((await fetch(`${base}/api/leads?token=secreto`)).status, 401, 'el token por URL no vale');
    assert.equal((await fetch(`${base}/api/leads`, { headers: { Authorization: 'Bearer otro' } })).status, 401);
    const auth = { Authorization: 'Bearer secreto', 'Content-Type': 'application/json' };
    const estado = await (await fetch(`${base}/api/estado`, { headers: auth })).json();
    assert.equal(estado.propiedades, 28);

    // Webhook: con App Secret, solo pasa la firma correcta.
    const num = h.numero();
    const body = JSON.stringify({ entry: [{ changes: [{ value: { contacts: [{ wa_id: num, profile: { name: 'Luz' } }], messages: [{ from: num, id: 'wamid.S1', type: 'text', text: { body: 'Hola, una consulta' } }] } }] }] });
    process.env.WHATSAPP_APP_SECRET = 's3cret';
    const firma = 'sha256=' + crypto.createHmac('sha256', 's3cret').update(body).digest('hex');
    assert.equal((await fetch(`${base}/webhook`, { method: 'POST', body })).status, 403);
    assert.equal((await fetch(`${base}/webhook`, { method: 'POST', body, headers: { 'x-hub-signature-256': 'sha256=mala' } })).status, 403);
    assert.equal(repo.getContacto(num), null);
    assert.equal((await fetch(`${base}/webhook`, { method: 'POST', body, headers: { 'x-hub-signature-256': firma } })).status, 200);

    // Quedó pendiente; se ve en el panel con su mensaje y se puede resolver.
    const pendientes = await (await fetch(`${base}/api/pendientes`, { headers: auth })).json();
    assert.equal(pendientes[0].numero, num);
    assert.equal(pendientes[0].mensajes[0].texto, 'Hola, una consulta');
    const r = await (await fetch(`${base}/api/pendientes/resolver`, { method: 'POST', headers: auth, body: JSON.stringify({ numero: num, decision: 'personal' }) })).json();
    assert.equal(r.ok, true);
    assert.deepEqual(h.cuerpos(), []);
  } finally {
    console.error = errores;
    delete process.env.ADMIN_TOKEN;
    delete process.env.WHATSAPP_APP_SECRET;
    server.close();
  }
});

test('sin App Secret el webhook solo se acepta en modo prueba', () => {
  const body = Buffer.from('{}');
  assert.equal(meta.verifySignature(body, {}), true); // WHATSAPP_DRY_RUN=1 en los tests
  delete process.env.WHATSAPP_DRY_RUN;
  try { assert.equal(meta.verifySignature(body, {}), false); } finally { process.env.WHATSAPP_DRY_RUN = '1'; }
});

test('#reiniciar: el lead arranca de cero sin borrar nada; a quien no es lead no se le responde', async () => {
  h.tmpDb();
  const sent = fakeProvider();
  let calls = fakeClaude(() => 'Te escribo en breve. [NOMBRE:Ana] [PROPIEDAD:VHO9477038] [DISPONIBILIDAD:jueves] [HANDOFF_AGENDA]');
  const num = h.numero();
  agent.handleEvents([inbound(num, `Quiero visitarla ${h.LINK_ZP}`)]);
  await agent.idle();
  assert.ok(repo.getLead(num).handoff_at);

  agent.handleEvents([inbound(num, '  #Reiniciar ')]);
  await agent.idle();
  await h.dormir(10);
  assert.equal(sent[sent.length - 1].text, 'Conversación reiniciada. Podés empezar de nuevo.');
  assert.equal(calls.length, 1, 'el comando no llega a Claude');
  const lead = repo.getLead(num);
  assert.deepEqual([lead.datos, lead.handoff_at, lead.pausado_at], [{}, null, null]);
  assert.equal(h.db.get().prepare('SELECT COUNT(*) n FROM mensajes').get().n, 2, 'los mensajes anteriores siguen en la base');
  assert.deepEqual(repo.events(num).find((e) => e.tipo === 'conversation_reset').payload.datos_anteriores.nombre, 'Ana');

  // La conversación siguiente no ve nada de la anterior, y ya no hace falta mandar un link.
  calls = fakeClaude(() => '¡Hola! Gracias por escribirme.');
  agent.handleEvents([inbound(num, 'hola')]);
  await agent.idle();
  assert.deepEqual(calls[0].messages, [{ role: 'user', content: 'hola' }]);
  assert.match(calls[0].system[1].text, /Datos ya capturados \(no los vuelvas a preguntar\): \{\}/);

  // Un desconocido que escribe el comando: pasa por el filtro como cualquier mensaje.
  const antes = sent.length;
  const otro = h.numero();
  agent.handleEvents([inbound(otro, '#reiniciar')]);
  await agent.idle();
  assert.equal(sent.length, antes);
  assert.equal(repo.getContacto(otro).tipo, 'pendiente');
});
