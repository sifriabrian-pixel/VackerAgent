// API de solo lectura para el panel de Vacker.
const test = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');

const repo = require('../src/repo');
const agent = require('../src/agent');
const llm = require('../src/llm');
const { agenda } = require('../src/agenda');
const { startServer } = require('../index');

test('panel: resumen, leads y conversación; el token del panel solo sirve para leer', async () => {
  h.tmpDb();
  process.env.MODO_OBSERVACION = 'false';
  agenda.reemplazar(['5493415550900']);
  agent.setProvider({ sendMessage: async () => ({ id: `wamid.${Math.random()}` }) });
  llm.setClient({ messages: { create: async () => ({ content: [{ type: 'text', text: 'Hola! Te paso la info. [NOMBRE:Eugenia] [USO:vivir] [PROPIEDAD:VHO9477038] [DISPONIBILIDAD:jueves] [HANDOFF_AGENDA]' }] }) } });

  const [lead, otro] = [h.numero(), h.numero()];
  agent.handleEvents([
    { kind: 'inbound', input: { ...h.msg(lead, `Hola ${h.LINK_ZP}`), messageId: 'p1' } },
    { kind: 'inbound', input: { ...h.msg(otro, 'Hola, una consulta'), messageId: 'p2', metadata: { profileName: 'Juan' } } },
    { kind: 'inbound', input: { ...h.msg('5493415550900', 'Hola Pablo, ¿venís el sábado?'), messageId: 'p3' } },
  ]);
  await agent.idle();
  repo.updateLead(otro, { handoff_tipo: null, handoff_at: null, calificado_at: null, datos: {} });
  agent.handleEvents([{ kind: 'owner', evento: { to: otro, text: 'Hola Juan, te llamo', messageId: 'o1' } }]);

  process.env.PORT = '0';
  process.env.ADMIN_TOKEN = 'admin';
  process.env.PANEL_TOKEN = 'panel';
  const server = startServer({ ruta: '/webhook', verifySignature: () => false, parseWebhook: () => [] });
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p, token = 'panel') => fetch(base + p, { headers: { Authorization: `Bearer ${token}` } });
  try {
    assert.equal((await get('/api/panel/resumen', 'otro')).status, 401);
    assert.equal((await get('/api/leads')).status, 401, 'el token del panel no abre la administración');
    assert.equal((await fetch(`${base}/api/panel/leads`, { method: 'POST', headers: { Authorization: 'Bearer panel' } })).status, 405);

    const r = await (await get('/api/panel/resumen')).json();
    assert.equal(r.leads, 2);
    assert.equal(r.visitas, 1);
    assert.equal(r.pablo_tomo, 1);
    assert.equal(r.personales_filtrados, 1);
    assert.deepEqual(r.por_canal, { anuncio: 0, portal: 1, directo: 1 });

    const leads = await (await get('/api/panel/leads')).json();
    const l = leads.find((x) => x.id === lead);
    assert.equal(l.etapa, 'visit_scheduled');
    assert.equal(l.nombre, 'Eugenia');
    assert.equal(l.propiedad.ref, 'VHO9477038');
    assert.equal(leads.find((x) => x.id === otro).etapa, 'taken');
    assert.equal(leads.find((x) => x.id === otro).nombre, 'Juan');

    const conv = await (await get(`/api/panel/leads/${otro}`)).json();
    assert.deepEqual(conv.mensajes.map((m) => m.autor), ['lead', 'agente', 'asesor']);
    assert.equal((await get('/api/panel/leads/5493415550900')).status, 404, 'de un contacto personal no hay nada');
  } finally {
    delete process.env.ADMIN_TOKEN;
    delete process.env.PANEL_TOKEN;
    server.close();
  }
});
