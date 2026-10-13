const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');
const h = require('./helpers');

const repo = require('../src/repo');
const core = require('../src/core');
const filtro = require('../src/filtro');
const inventario = require('../src/inventario');
const { buildSystemPrompt } = require('../src/prompt');
const { createTestAdapter } = require('../src/test-adapter');

const avisos = (out, tipo) => out.actions.filter((a) => a.type === tipo);

// ─── Filtro ──────────────────────────────────────────────────────────────────

test('filtro: orden de las reglas', () => {
  const d = (contacto, text, referral) => filtro.decidir({ contacto, input: { text, metadata: { referral } } }).decision;
  assert.equal(d({ tipo: 'bloqueado' }, 'hola', h.ANUNCIO), 'ignorar');
  assert.equal(d({ tipo: 'lead' }, 'cualquier cosa'), 'lead');
  assert.equal(d({ tipo: 'conocido', origen: 'historial' }, `mirá ${h.LINK_ZP}`), 'personal');
  assert.equal(d({ tipo: 'personal' }, 'vi tu anuncio'), 'personal');
  assert.equal(d({ tipo: 'conocido' }, 'hola', h.ANUNCIO), 'pendiente');
  assert.equal(d(null, '¡Hola! Quiero más información.', h.ANUNCIO), 'lead');
  assert.equal(d(null, `Hola, me interesa ${h.LINK_ZP}`), 'lead');
  assert.equal(d(null, 'vi esto https://casa.mercadolibre.com.ar/MLA-123456789-casa-_JM'), 'lead');
  // Sin anuncio ni link no hay forma segura de saber: no se responde solo.
  for (const texto of ['Hola, sigue disponible la casa de Funes?', 'Eze te hago una consulta por el asado', 'vi un anuncio de un auto', 'Feliz cumple!']) {
    assert.equal(d(null, texto), 'pendiente', texto);
  }
});

test('lead por anuncio: responde, identifica la propiedad del anuncio y guarda la conversación', async () => {
  const llm = h.guion(['Te paso la info 👇 ... ¿Me decís tu nombre? [PROPIEDAD:VHO9477038]']);
  const a = createTestAdapter({ llm });
  const num = h.numero();
  const out = await a.handleMessage(h.msg(num, '¡Hola! Quiero más información.', { metadata: { referral: h.ANUNCIO, profileName: 'Caro' } }));

  assert.equal(out.state.decision, 'lead');
  assert.equal(out.state.canal, 'meta');
  assert.deepEqual(out.messages, ['Te paso la info 👇 ... ¿Me decís tu nombre?']);
  assert.equal(out.state.propiedad, 'VHO9477038');
  assert.match(llm.calls[0].contexto, /Propiedad de esta consulta: VHO9477038/);
  assert.match(llm.calls[0].contexto, /Llegó desde un anuncio de Meta: "Casa en Funes/);
  assert.ok(repo.events(num).some((e) => e.tipo === 'propiedad_identificada' && e.payload.por.startsWith('anuncio')));
  assert.equal(out.state.nombre, 'Caro'); // respaldo: nombre del perfil
});

test('sin señal clara: queda pendiente, no llama a Claude ni responde; al resolverlo como lead responde lo retenido', async () => {
  const llm = h.guion(['Hola! Contame por cuál propiedad me escribís.']);
  const a = createTestAdapter({ llm });
  const num = h.numero();
  let out = await a.handleMessage(h.msg(num, 'Hola, sigue disponible la casa de Funes?'));
  out = await a.handleMessage(h.msg(num, 'la de calle Sarmiento'));
  assert.equal(out.state.decision, 'pendiente');
  assert.deepEqual(out.messages, []);
  assert.equal(llm.calls.length, 0);
  assert.equal(repo.getContacto(num).tipo, 'pendiente');
  assert.equal(repo.retenidos(num).length, 2);

  const resuelto = await a.resolverPendiente(num, 'lead');
  assert.equal(resuelto.messages.length, 1);
  assert.equal(llm.calls.length, 1);
  assert.match(llm.calls[0].historial[0].content, /casa de Funes\?\nla de calle Sarmiento/);
  assert.equal(repo.getContacto(num).tipo, 'lead');
});

test('pendiente resuelto como personal: no se conserva nada de lo que escribió', async () => {
  const a = createTestAdapter({ llm: h.guion(['x']) });
  const num = h.numero();
  await a.handleMessage(h.msg(num, 'Eze, te hago una consulta por el asado del domingo'));
  await a.resolverPendiente(num, 'personal');
  assert.equal(repo.getContacto(num).tipo, 'personal');
  assert.deepEqual(h.cuerpos(), []);
  const out = await a.handleMessage(h.msg(num, 'dale, llevo el vino'));
  assert.equal(out.state.decision, 'personal');
  assert.deepEqual(h.cuerpos(), []);
});

test('conocidos: nunca se responde y nunca se guarda el texto, aunque mande un link', async () => {
  const llm = h.guion(['x']);
  const a = createTestAdapter({ llm });
  const [hist, escrito] = [h.numero(), h.numero()];
  assert.equal(a.syncHistory([`+${hist}`]), 1);
  assert.equal(a.ownerMessage({ to: escrito, text: 'Dale, nos vemos mañana', messageId: 'o1' }).accion, 'conocido');

  for (const num of [hist, escrito]) {
    const out = await a.handleMessage(h.msg(num, `Mirá esta casa ${h.LINK_ZP}`));
    assert.equal(out.state.decision, 'personal');
    assert.deepEqual(out.messages, []);
  }
  assert.equal(llm.calls.length, 0);
  assert.deepEqual(h.cuerpos(), [], 'no quedó ningún texto de un contacto personal');
  assert.equal(repo.getLead(escrito), null, 'un mensaje del asesor nunca crea un lead');
});

test('conocido que entra por un anuncio: queda pendiente para revisar', async () => {
  const a = createTestAdapter({ llm: h.guion(['x']) });
  const num = h.numero();
  a.syncHistory([num]);
  const out = await a.handleMessage(h.msg(num, 'Hola, quiero info', { metadata: { referral: h.ANUNCIO } }));
  assert.equal(out.state.decision, 'pendiente');
  assert.equal(out.state.motivo, 'conocido_con_anuncio');
  assert.deepEqual(out.messages, []);
  // Si alguien lo descarta, vuelve a ser conocido.
  await a.resolverPendiente(num, 'personal');
  assert.equal(repo.getContacto(num).tipo, 'conocido');
});

test('el asesor escribe en una conversación del agente: el agente se pausa ahí', async () => {
  const llm = h.guion(['Te paso la info.']);
  const a = createTestAdapter({ llm });
  const num = h.numero();
  await a.handleMessage(h.msg(num, `Hola ${h.LINK_ZP}`));
  assert.equal(a.ownerMessage({ to: num, text: 'Hola, te llamo en un rato', messageId: 'o2' }).accion, 'pausado');
  const out = await a.handleMessage(h.msg(num, 'dale, te espero'));
  assert.deepEqual(out.messages, []);
  assert.equal(out.state.pausado, true);
  assert.equal(llm.calls.length, 1);
  assert.equal(repo.pendingInbound(num).length, 0);
  assert.ok(h.cuerpos().includes('dale, te espero'), 'el mensaje queda en el historial del lead');
});

test('lo que envía el propio agente no se confunde con un mensaje del asesor', async () => {
  const a = createTestAdapter({ llm: h.guion(['Te paso la info.']) });
  const num = h.numero();
  const out = await a.handleMessage(h.msg(num, `Hola ${h.LINK_ZP}`));
  repo.markOutbound(out.meta.outboundId, 'enviado', 'wamid.AGENTE');
  assert.equal(a.ownerMessage({ to: num, text: 'Te paso la info.', messageId: 'wamid.AGENTE' }).accion, 'propio');
  assert.equal(repo.getLead(num).pausado_at, null);
});

test('modo observación: registra qué decidiría, pero no responde ni guarda mensajes', async () => {
  const llm = h.guion(['x']);
  const a = createTestAdapter({ llm, observacion: true });
  const [lead, dudoso, amigo] = [h.numero(), h.numero(), h.numero()];
  a.ownerMessage({ to: amigo, text: 'nos vemos', messageId: 'o3' });
  const salidas = [
    await a.handleMessage(h.msg(lead, 'Hola', { metadata: { referral: h.ANUNCIO } })),
    await a.handleMessage(h.msg(dudoso, 'Hola, una consulta')),
    await a.handleMessage(h.msg(amigo, 'dale')),
  ];
  assert.deepEqual(salidas.map((s) => s.state.decision), ['lead', 'pendiente', 'personal']);
  assert.ok(salidas.every((s) => s.messages.length === 0));
  assert.equal(llm.calls.length, 0);
  assert.deepEqual(h.cuerpos(), []);
  assert.equal(repo.getContacto(lead), null);
  const decisiones = repo.eventosPorTipo('filtro').map((e) => e.payload);
  assert.equal(decisiones.length, 3);
  assert.ok(decisiones.every((p) => p.observacion === true && !('texto' in p)));
  assert.equal(repo.getContacto(amigo).tipo, 'conocido', 'aprende a quién le escribe el asesor');
});

test('un mensaje repetido por el proveedor no genera otra respuesta', async () => {
  const llm = h.guion(['Hola']);
  const a = createTestAdapter({ llm });
  const num = h.numero();
  await a.handleMessage(h.msg(num, `Hola ${h.LINK_ZP}`, { messageId: 'wamid.DUP' }));
  const repetido = await a.handleMessage(h.msg(num, `Hola ${h.LINK_ZP}`, { messageId: 'wamid.DUP' }));
  assert.equal(repetido.state.decision, 'duplicado');
  assert.deepEqual(repetido.messages, []);
  assert.equal(llm.calls.length, 1);
});

// ─── Conversación ────────────────────────────────────────────────────────────

test('ninguna etiqueta le llega al lead, ni las inventadas', async () => {
  const textos = [
    'Genial Juan. [NOMBRE:Juan] [OPERACION:compra] [ZONA:Centro] [PRESUPUESTO:90000] [PROPIEDAD:VHO9477038]',
    'Anotado. [AMBIENTES:3] [FOLLOWUP_TRIGGER]',
    'Perfecto. [USO:inversion] ¿Qué zona?',
    'Listo. [HANDOFF_GENERAL ]',
    'Dale. [nombre:juan] [LEAD_QUALIFIED]',
  ];
  const a = createTestAdapter({ llm: h.guion(textos) });
  const num = h.numero();
  const enviados = [];
  for (let i = 0; i < textos.length; i++) enviados.push(...(await a.handleMessage(h.msg(num, i ? `mensaje ${i}` : `Hola ${h.LINK_ZP}`))).messages);
  assert.deepEqual(enviados, ['Genial Juan.', 'Anotado.', 'Perfecto. ¿Qué zona?', 'Listo.', 'Dale.']);
  assert.deepEqual(repo.getLead(num).datos, { nombre: 'juan', operacion: 'compra', zona: 'Centro', presupuesto: '90000', propiedad: 'VHO9477038' });
});

test('una propiedad que no existe en el archivo no se registra', async () => {
  const a = createTestAdapter({ llm: h.guion(['Te paso la info. [PROPIEDAD:XX000]']) });
  const num = h.numero();
  const out = await a.handleMessage(h.msg(num, `Hola ${h.LINK_ZP}`));
  assert.equal(out.state.propiedad, null);
});

test('cierre con visita: no deriva sin nombre; con los datos completos deriva una sola vez', async () => {
  const llm = h.guion([
    'Perfecto, quedó anotado. Te escribo en breve. [PROPIEDAD:VHO9477038] [DISPONIBILIDAD:jueves 17 hs] [HANDOFF_AGENDA]',
    'Gracias Ana. [NOMBRE:Ana]',
    'Sí, tiene cochera. [HANDOFF_AGENDA]',
  ]);
  const a = createTestAdapter({ llm });
  const num = h.numero();
  let out = await a.handleMessage(h.msg(num, 'Quiero visitarla el jueves 17 hs', { metadata: { referral: h.ANUNCIO } }));
  assert.equal(out.state.derived, false);
  assert.equal(avisos(out, 'handoff').length, 0);
  assert.deepEqual(repo.events(num).find((e) => e.tipo === 'handoff_bloqueado').payload, { tipo: 'agenda', faltantes: ['nombre'] });

  // El turno siguiente le avisa a Claude qué falta; cuando llega el dato, deriva sin esperar otra etiqueta.
  out = await a.handleMessage(h.msg(num, 'Ana'));
  assert.match(llm.calls[1].contexto, /Para cerrar faltan estos datos: nombre/);
  assert.equal(out.state.derived, true);
  assert.equal(out.state.handoffTipo, 'agenda');
  assert.equal(avisos(out, 'handoff').length, 1);
  assert.equal(avisos(out, 'handoff')[0].payload.nombre, 'Ana');

  // Lead de anuncio → se carga en Tokko, con los datos reales.
  const tokko = avisos(out, 'create_tokko_contact');
  assert.equal(tokko.length, 1);
  assert.equal(tokko[0].payload.name, 'Ana');
  assert.equal(tokko[0].payload.phone, num);
  assert.match(tokko[0].payload.text, /Consulta por VHO9477038.*Quiere visitar: jueves 17 hs/);

  // Después de derivar sigue respondiendo dudas, pero no deriva de nuevo.
  out = await a.handleMessage(h.msg(num, 'ah, y tiene cochera?'));
  assert.deepEqual(out.messages, ['Sí, tiene cochera.']);
  assert.deepEqual(out.actions, []);
  assert.match(llm.calls[2].contexto, /YA quedó cerrada/);
  assert.equal(a.actions.filter((x) => x.type === 'handoff').length, 1);
});

test('lead de portal: deriva pero no se carga en Tokko; pedir hablar con Pablo deriva sin más datos', async () => {
  const a = createTestAdapter({ llm: h.guion(['Dale, te escribo en breve. [HANDOFF_GENERAL]']) });
  const out = await a.handleMessage(h.msg(h.numero(), `Prefiero que me llames ${h.LINK_ZP}`));
  assert.equal(out.state.derived, true);
  assert.equal(avisos(out, 'handoff')[0].payload.tipo, 'general');
  assert.equal(avisos(out, 'create_tokko_contact').length, 0);
});

test('conversación larga: todos los mensajes reciben respuesta', async () => {
  const llm = h.guion((hist, ctx, n) => `respuesta ${n}`);
  const a = createTestAdapter({ llm });
  const num = h.numero();
  let respondidos = 0;
  for (let i = 1; i <= 30; i++) respondidos += (await a.handleMessage(h.msg(num, i === 1 ? `Hola ${h.LINK_ZP}` : `mensaje ${i}`))).messages.length;
  assert.equal(respondidos, 30);
  assert.ok(llm.calls.every((c) => c.historial[0].role === 'user'));
  assert.ok(llm.calls[29].historial.length <= 42);
});

test('si Claude falla, handleMessage lanza y el mensaje queda pendiente', async () => {
  const a = createTestAdapter({ llm: { chat: async () => { throw new Error('529 overloaded'); } } });
  const num = h.numero();
  await assert.rejects(a.handleMessage(h.msg(num, `Hola ${h.LINK_ZP}`)), /529/);
  assert.equal(repo.pendingInbound(num).length, 1);
});

// ─── Qué propiedad es ────────────────────────────────────────────────────────

test('link de portal: si la publicación dice la dirección, identifica la propiedad', async () => {
  const llm = h.guion(['ficha']);
  const a = createTestAdapter({ llm, paginas: { [h.LINK_ZP]: 'Casa en venta en Sarmiento al 2400, Funes - ZonaProp' } });
  const out = await a.handleMessage(h.msg(h.numero(), `Hola, vi esta ${h.LINK_ZP}`));
  assert.equal(out.state.propiedad, 'VHO9477038');
  assert.match(llm.calls[0].contexto, /Propiedad de esta consulta: VHO9477038: Casa en venta, Sarmiento al 2400 \(Funes\), USD 260\.000/);
});

test('link de portal que no se puede leer: no adivina, le indica al agente que pregunte', async () => {
  const llm = h.guion(['¿Me pasás la dirección?']);
  const a = createTestAdapter({ llm });
  let out = await a.handleMessage(h.msg(h.numero(), `Hola ${h.LINK_ZP}`));
  assert.equal(out.state.propiedad, null);
  assert.match(llm.calls[0].contexto, /link de ZonaProp que puede ser una de estas: VHO9477038/);

  out = await a.handleMessage(h.msg(h.numero(), 'Hola https://www.zonaprop.com.ar/propiedades/clasificado/alquiler-99887766.html'));
  assert.equal(out.state.propiedad, null);
  assert.match(llm.calls[1].contexto, /no se pudo identificar la propiedad\. Pedile la dirección/);
});

test('el lead nombra el código o la dirección: se identifica; palabras sueltas no alcanzan', async () => {
  const id = (t) => { const r = inventario.identificar(t); return r.prop ? r.prop.tokko_ref : null; };
  assert.equal(id('consulto por VHO9477038'), 'VHO9477038');
  assert.equal(id('me interesa la casa de Alem 4300'), 'VHO8423980');
  assert.equal(id('PH Córdoba 2700'), 'VPH8424414');
  for (const t of ['soy de Córdoba y me mudo a Rosario', 'vengo de San Juan, vivo por Alberdi', 'estaba navegando y vi una casa', 'departamento en Cerrito', 'casa en Abasto']) {
    assert.equal(id(t), null, t);
  }
});

test('el prompt trae las 28 propiedades y habla como Pablo en primera persona', () => {
  const p = buildSystemPrompt();
  assert.equal(inventario.cargar().length, 28);
  for (const prop of inventario.cargar()) assert.ok(p.includes(`Código: ${prop.tokko_ref}`), prop.tokko_ref);
  assert.match(p, /^Sos Pablo Sugamele/);
  assert.match(p, /Te escribo en breve para confirmar el horario/);
  assert.match(p, /PRIMER mensaje.*"¡Hola! Gracias por escribirme, te saluda Pablo Sugamele de Vacker Negocios Inmobiliarios/);
  assert.ok(!/None|null|undefined/.test(p), 'sin datos vacíos en las fichas');
});

test('el contexto le dice a Claude si está en horario (hora de Argentina, sin depender del servidor)', async () => {
  const llm = h.guion(['ok']);
  const a = createTestAdapter({ llm });
  const casos = [
    ['2026-10-13T20:30:00Z', /SÍ, estás en horario/],   // martes 17:30
    ['2026-10-14T09:30:00Z', /NO, estás fuera de horario/], // miércoles 06:30
    ['2026-10-17T16:00:00Z', /SÍ, estás en horario/],   // sábado 13:00
    ['2026-10-18T15:00:00Z', /NO, estás fuera de horario/], // domingo
  ];
  for (const [now, esperado] of casos) {
    await a.handleMessage(h.msg(h.numero(), `Hola ${h.LINK_ZP}`, { now }));
    assert.match(llm.calls[llm.calls.length - 1].contexto, esperado, now);
  }
});

// ─── Seguridad del arnés ─────────────────────────────────────────────────────

test('el core y el adapter de test no cargan ningún transporte ni Tokko', () => {
  const script = "require('./src/core'); require('./src/test-adapter');"
    + "process.exit(Object.keys(require.cache).some((f) => /adapters|tokko\\.js|agent\\.js|axios/.test(f)) ? 1 : 0)";
  assert.equal(spawnSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..') }).status, 0);
});

test('el adapter de test se niega a arrancar con credenciales reales en el entorno', () => {
  process.env.TOKKO_API_KEY = 'x';
  try { assert.throws(() => createTestAdapter(), /credenciales reales/); } finally { delete process.env.TOKKO_API_KEY; }
});

test('tick todavía no genera seguimientos', async () => {
  const a = createTestAdapter({ llm: h.guion(['ok']) });
  const num = h.numero();
  await a.handleMessage(h.msg(num, `Hola ${h.LINK_ZP}`));
  const out = await a.tick(num, '2026-10-20T15:00:00Z');
  assert.deepEqual([out.messages, out.actions], [[], []]);
  assert.equal(core.enObservacion({}), true, 'por defecto el agente arranca en modo observación');
});
