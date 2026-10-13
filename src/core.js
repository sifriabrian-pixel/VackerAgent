// Core del agente de Vacker: toda la lógica, sin transporte.
//
// Nunca envía nada ni escribe en sistemas externos: devuelve lo que habría que
// enviar (messages) y los efectos a ejecutar (actions). El adapter (agent.js +
// adapters/*) los ejecuta; el de test (test-adapter.js) solo los registra.
//
//   ingest(input)               filtro lead/personal + guarda el mensaje (sincrónico)
//   processPending(numero)      responde lo pendiente de ese lead
//   handleMessage(input)        = ingest + processPending (lo que usa el QA)
//   ownerMessage(evento)        el asesor escribió desde su WhatsApp
//   syncHistory(numeros)        chats que el asesor ya tenía → conocidos
//   resolverPendiente(numero)   alguien (o el clasificador) decide un pendiente
//   tick(numero, now)           seguimientos programados (todavía no hay)
//
// AgentInput  = { conversationId, from, text, now?, messageId?, type?,
//                 metadata?: { referral?, profileName? } }
// AgentAction = { type: 'handoff' | 'create_tokko_contact', payload }
// AgentOutput = { messages, actions, state, meta }
//
// deps = { store, llm, leerPortal, onLlmError, observacion }
const config = require('../config/vacker');
const repo = require('./repo');
const llmReal = require('./llm');
const clock = require('./clock');
const filtro = require('./filtro');
const inventario = require('./inventario');
const portales = require('./portales');

const MAX_VUELTAS_TURNO = 3;
const MSG_VACIO = 'Perdón, no llegué a entenderte. ¿Me lo escribís de nuevo?';

// Modo observación (por defecto): el agente mira y registra qué decidiría el
// filtro, pero no responde ni guarda mensajes. Se apaga con MODO_OBSERVACION=false.
function enObservacion(deps = {}) {
  return deps.observacion !== undefined ? deps.observacion : process.env.MODO_OBSERVACION !== 'false';
}

// ─── Etiquetas del LLM ───────────────────────────────────────────────────────

const DATO_RE = /\[(NOMBRE|OPERACION|PRESUPUESTO|DORMITORIOS|ZONA|URGENCIA|DISPONIBILIDAD|PROPIEDAD)\s*:\s*([^\]\n]*)\]/gi;
const HANDOFF_RE = /\[HANDOFF_(AGENDA|BUSQUEDA|GENERAL)\s*\]/i;
// Cualquier cosa con forma de etiqueta, esté o no en la lista: nunca llega al lead.
const ETIQUETA_RE = /\[[A-Za-z_]{2,30}(?:\s*:[^\]\n]*)?\s*\]/g;

function parseSalida(raw) {
  const datos = {};
  for (const [, clave, valor] of String(raw).matchAll(DATO_RE)) {
    const v = valor.trim();
    if (v) datos[clave.toLowerCase()] = v;
  }
  if (datos.propiedad) {
    const prop = inventario.porRef(datos.propiedad);
    if (prop) datos.propiedad = prop.tokko_ref; else delete datos.propiedad;
  }
  if (datos.operacion) {
    const op = datos.operacion.toLowerCase();
    datos.operacion = op.startsWith('alq') ? 'alquiler' : op.startsWith('comp') ? 'compra' : undefined;
    if (!datos.operacion) delete datos.operacion;
  }
  const handoff = String(raw).match(HANDOFF_RE)?.[1].toLowerCase() || null;
  const texto = String(raw).replace(ETIQUETA_RE, '').replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { texto, datos, handoff };
}

// ─── Horario ─────────────────────────────────────────────────────────────────

function horaArgentina() {
  const partes = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: config.zonaHoraria, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(clock.date()).map((p) => [p.type, p.value]));
  return { dia: partes.weekday, hhmm: `${partes.hour}:${partes.minute}` };
}

function enHorario() {
  const { dia, hhmm } = horaArgentina();
  if (dia === 'Sun') return false;
  const [desde, hasta] = dia === 'Sat' ? config.horario.sabado : config.horario.semana;
  return hhmm >= desde && hhmm < hasta;
}

// ─── Derivación ──────────────────────────────────────────────────────────────

const tiene = (v) => v !== undefined && v !== null && v !== '';

function faltantesPara(tipo, datos) {
  return (config.derivacion[tipo] || []).filter((campo) => !tiene(datos[campo]));
}

// Último cierre que el LLM intentó y quedó frenado por falta de datos.
function cierreFrenado(eventos) {
  let tipo = null;
  for (const e of eventos) {
    if (e.tipo === 'handoff_bloqueado') tipo = e.payload.tipo;
    if (e.tipo === 'handoff' || e.tipo === 'conversation_reset') tipo = null;
  }
  return tipo;
}

function comentarioTokko(lead, tipo) {
  const d = lead.datos;
  const prop = d.propiedad ? inventario.porRef(d.propiedad) : null;
  const partes = ['Lead de WhatsApp (anuncio de Meta).'];
  if (prop) partes.push(`Consulta por ${inventario.resumen(prop)}.`);
  if (tipo === 'agenda' && d.disponibilidad) partes.push(`Quiere visitar: ${d.disponibilidad}.`);
  if (d.operacion) partes.push(`Operación: ${d.operacion}.`);
  if (d.presupuesto) partes.push(`Presupuesto: ${d.presupuesto}.`);
  if (d.dormitorios) partes.push(`Dormitorios: ${d.dormitorios}.`);
  if (d.zona) partes.push(`Zona: ${d.zona}.`);
  if (d.urgencia) partes.push(`Para cuándo: ${d.urgencia}.`);
  return partes.join(' ');
}

// ─── Contexto del turno ──────────────────────────────────────────────────────

function buildContext(lead, { pistas = [], faltantes = [], cierre = null } = {}) {
  const fecha = clock.date().toLocaleString('es-AR', { timeZone: config.zonaHoraria, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  const lineas = [
    'CONTEXTO DE ESTA CONVERSACIÓN (información del sistema; no la cites textual):',
    `- Fecha y hora en Argentina: ${fecha}. Horario de atención: ${enHorario() ? 'SÍ, estás en horario' : 'NO, estás fuera de horario'}.`,
  ];
  if (lead.nombre_perfil) lineas.push(`- Nombre del perfil de WhatsApp: ${lead.nombre_perfil} (puede no ser su nombre real; pedilo igual).`);
  if (lead.canal === 'meta') {
    const r = lead.referral || {};
    const anuncio = [r.headline, r.body].filter(Boolean).join(' — ');
    lineas.push(`- Llegó desde un anuncio de Meta${anuncio ? `: "${anuncio.slice(0, 300)}"` : ''}.`);
  } else if (lead.canal === 'portal') {
    lineas.push('- Llegó con un link de un portal inmobiliario.');
  }
  if (lead.datos.propiedad) {
    const prop = inventario.porRef(lead.datos.propiedad);
    if (prop) lineas.push(`- Propiedad de esta consulta: ${inventario.resumen(prop)}.`);
  }
  lineas.push(...pistas.map((p) => `- ${p}`));
  lineas.push(`- Datos ya capturados (no los vuelvas a preguntar): ${JSON.stringify(lead.datos)}`);
  if (lead.handoff_at) lineas.push('- Esta consulta YA quedó cerrada y anotada: respondé dudas, no vuelvas a ofrecer la visita ni repitas la etiqueta de cierre.');
  else if (cierre && faltantes.length) lineas.push(`- Para cerrar faltan estos datos: ${faltantes.join(', ')}. Pedilos (de a uno) antes de cerrar.`);
  return lineas.join('\n');
}

// Convierte el historial al formato de la API: alterna roles, une mensajes
// seguidos del mismo rol y arranca siempre con el usuario.
function toApiMessages(rows) {
  const out = [];
  for (const r of rows) {
    const role = r.autor === 'lead' ? 'user' : 'assistant';
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n${r.cuerpo}`;
    else out.push({ role, content: r.cuerpo });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

// ─── Qué propiedad es ────────────────────────────────────────────────────────

// Mira el anuncio y los links del lead para saber de qué propiedad habla.
// Si hay una sola coincidencia clara la fija; si no, deja una pista para que
// el agente pregunte. Nunca adivina.
async function identificarPropiedad(lead, pendientes, { store, leerPortal }) {
  if (lead.datos.propiedad) return [];
  const pistas = [];
  const fijar = (prop, por) => {
    store.updateLead(lead.numero, { datos: { ...lead.datos, propiedad: prop.tokko_ref } });
    store.addEvent(lead.numero, 'propiedad_identificada', { ref: prop.tokko_ref, por });
    lead.datos.propiedad = prop.tokko_ref;
  };
  const candidatos = (lista) => lista.map((p) => inventario.resumen(p)).join(' | ');

  const texto = pendientes.map((m) => m.cuerpo || '').join('\n');
  const link = portales.detectar(texto);
  if (link) {
    const leido = await leerPortal(link.url);
    const r = inventario.identificar([leido, portales.textoDeUrl(link.url), link.url].filter(Boolean).join(' | '));
    if (r.prop) { fijar(r.prop, `link_${r.por}`); return pistas; }
    pistas.push(r.candidatos.length
      ? `Mandó un link de ${link.portal} que puede ser una de estas: ${candidatos(r.candidatos)}. Preguntá un dato para confirmar cuál es.`
      : `Mandó un link de ${link.portal} y no se pudo identificar la propiedad. Pedile la dirección o el tipo de propiedad y el barrio.`);
  }

  const ref = lead.referral;
  if (!lead.datos.propiedad && ref) {
    const r = inventario.identificar([ref.headline, ref.body, ref.source_url].filter(Boolean).join(' | '));
    if (r.prop) { fijar(r.prop, `anuncio_${r.por}`); return pistas; }
    if (r.candidatos.length) pistas.push(`El anuncio puede ser de una de estas: ${candidatos(r.candidatos)}. Preguntá un dato para confirmar cuál es.`);
  }

  if (!lead.datos.propiedad && !link) {
    const r = inventario.identificar(texto);
    if (r.prop) fijar(r.prop, `mensaje_${r.por}`);
  }
  return pistas;
}

// ─── Estado ──────────────────────────────────────────────────────────────────

function buildState(numero, store, extra = {}) {
  const contacto = store.getContacto(numero);
  const lead = store.getLead(numero);
  if (!lead) return { numero, tipo: contacto?.tipo || null, ...extra };
  return {
    numero,
    tipo: 'lead',
    canal: lead.canal,
    datos: lead.datos,
    nombre: lead.datos.nombre || lead.nombre_perfil || null,
    propiedad: lead.datos.propiedad || null,
    qualified: Boolean(lead.calificado_at),
    derived: Boolean(lead.handoff_at),
    handoffTipo: lead.handoff_tipo,
    pausado: Boolean(lead.pausado_at),
    ...extra,
  };
}

const vacio = (numero, store, extra) => ({ messages: [], actions: [], state: buildState(numero, store, extra), meta: { numero, outboundId: null } });

// ─── Entrada ─────────────────────────────────────────────────────────────────

function promoverALead(numero, { origen, canal, referral, perfil }, store) {
  store.setContacto(numero, 'lead', origen, perfil);
  store.createLead(numero, { canal, referral });
  return store.liberarRetenidos(numero);
}

// Pasa el mensaje por el filtro y, si corresponde, lo guarda. Sincrónico: el
// webhook lo llama ANTES de responder 200. De quien no es lead no guarda texto.
function ingest(input, deps = {}) {
  return clock.run(input.now, () => {
    const store = deps.store || repo;
    const numero = repo.digitos(input.conversationId);
    if (!store.marcarVisto(input.messageId)) return { decision: 'duplicado', motivo: 'ya_visto', nuevo: false };

    const contacto = store.getContacto(numero);
    const referral = input.metadata?.referral || null;
    const perfil = input.metadata?.profileName || null;
    const r = filtro.decidir({ contacto, input });
    const observando = enObservacion(deps);
    store.addEvent(numero, 'filtro', { decision: r.decision, motivo: r.motivo, tipo_mensaje: input.type || 'text', ...(observando ? { observacion: true } : {}) });

    if (observando || r.decision === 'ignorar' || r.decision === 'personal' || input.text == null) return { ...r, nuevo: false };

    if (r.decision === 'pendiente') {
      store.setContacto(numero, 'pendiente', r.motivo, perfil);
      if (referral) store.addEvent(numero, 'referral', referral);
      store.insertMensaje({ numero, direccion: 'in', autor: 'lead', proveedorId: input.messageId, tipo: input.type || 'text', cuerpo: input.text, estado: 'retenido' });
      return { ...r, nuevo: false };
    }

    if (!contacto || contacto.tipo !== 'lead') promoverALead(numero, { origen: r.motivo, canal: r.canal || 'directo', referral, perfil }, store);
    store.insertMensaje({ numero, direccion: 'in', autor: 'lead', proveedorId: input.messageId, tipo: input.type || 'text', cuerpo: input.text, estado: 'pendiente' });
    store.updateLead(numero, { ultimo_lead_at: clock.nowISO() });
    return { ...r, nuevo: true };
  });
}

// Alguien (una persona desde el panel, o el clasificador) decide un pendiente.
// 'lead' → el agente responde lo que quedó retenido. 'personal' → se borra todo.
function resolverPendiente(numeroCrudo, decision, { store = repo, origen = 'resuelto_manual' } = {}) {
  const numero = repo.digitos(numeroCrudo);
  const contacto = store.getContacto(numero);
  if (!contacto || contacto.tipo !== 'pendiente') return { ok: false, motivo: 'no_es_pendiente' };
  if (decision === 'lead') {
    const referral = store.events(numero).filter((e) => e.tipo === 'referral').pop()?.payload || null;
    const liberados = promoverALead(numero, { origen, canal: referral ? 'meta' : 'directo', referral, perfil: null }, store);
    store.addEvent(numero, 'pendiente_resuelto', { decision, origen });
    return { ok: true, liberados };
  }
  store.borrarMensajes(numero);
  store.setContacto(numero, contacto.origen === 'conocido_con_anuncio' ? 'conocido' : 'personal', origen);
  store.addEvent(numero, 'pendiente_resuelto', { decision: 'personal', origen });
  return { ok: true, liberados: 0 };
}

// El asesor escribió desde su WhatsApp. Nunca crea un lead.
//   - En una conversación del agente: el agente se pausa ahí.
//   - En cualquier otro chat: ese número queda como conocido.
function ownerMessage(evento, { store = repo } = {}) {
  return clock.run(evento.now, () => {
    const numero = repo.digitos(evento.to);
    if (!numero) return { accion: 'ignorado' };
    // El proveedor puede devolver como "enviado por el asesor" lo que mandó el propio agente.
    if (store.esMensajeDelAgente(evento.messageId)) return { accion: 'propio' };
    if (!store.marcarVisto(evento.messageId)) return { accion: 'duplicado' };

    const contacto = store.getContacto(numero);
    if (contacto?.tipo === 'bloqueado') return { accion: 'ignorado' };

    if (contacto?.tipo === 'lead') {
      const lead = store.getLead(numero);
      if (evento.text) store.insertMensaje({ numero, direccion: 'out', autor: 'asesor', proveedorId: evento.messageId, cuerpo: evento.text, estado: 'registrado' });
      if (!lead.pausado_at) {
        store.updateLead(numero, { pausado_at: clock.nowISO() });
        store.addEvent(numero, 'pausado', { motivo: 'asesor_escribio' });
      }
      return { accion: 'pausado' };
    }

    if (contacto?.tipo === 'pendiente') store.borrarMensajes(numero);
    if (contacto?.tipo !== 'conocido') {
      store.setContacto(numero, 'conocido', 'asesor_escribio');
      store.addEvent(numero, 'conocido', { origen: 'asesor_escribio' });
    }
    return { accion: 'conocido' };
  });
}

// Chats que el asesor ya tenía antes del agente: quedan como conocidos.
function syncHistory(numeros, { store = repo } = {}) {
  let nuevos = 0;
  for (const crudo of numeros) {
    const numero = repo.digitos(crudo);
    if (!numero || store.getContacto(numero)) continue;
    store.setContacto(numero, 'conocido', 'historial');
    nuevos += 1;
  }
  return nuevos;
}

// ─── Turno ───────────────────────────────────────────────────────────────────

async function turno(numero, deps = {}, vuelta = 1) {
  const { store = repo, llm = llmReal, leerPortal = portales.leer, onLlmError } = deps;
  const pendientes = store.pendingInbound(numero);
  let lead = store.getLead(numero);
  if (!lead || !pendientes.length) return vacio(numero, store);

  // El asesor tomó la conversación (o está cerrada): el mensaje queda en el
  // historial, pero el agente no responde.
  if (lead.pausado_at || lead.cerrado_at) {
    store.commitTurn({ numero, inboundIds: pendientes.map((m) => m.id), replyText: null });
    return vacio(numero, store);
  }

  const pistas = await identificarPropiedad(lead, pendientes, { store, leerPortal });
  const cierre = lead.handoff_at ? null : cierreFrenado(store.events(numero));
  const contexto = buildContext(lead, { pistas, cierre, faltantes: cierre ? faltantesPara(cierre, lead.datos) : [] });
  const historial = toApiMessages([...store.history(numero, config.historialMax), ...pendientes.filter((m) => m.cuerpo)]);

  let salida;
  try {
    salida = parseSalida(await llm.chat(historial, contexto));
  } catch (e) {
    if (!onLlmError) throw e;
    const texto = await onLlmError(e, { lead, pendientes });
    if (texto == null) return null;
    salida = { texto, datos: {}, handoff: null };
  }

  // Entraron mensajes mientras Claude respondía: se descarta y se responde todo junto.
  if (vuelta < MAX_VUELTAS_TURNO && store.pendingInbound(numero).length > pendientes.length) return turno(numero, deps, vuelta + 1);

  lead = store.getLead(numero);
  const nuevos = Object.fromEntries(Object.entries(salida.datos).filter(([k, v]) => lead.datos[k] !== v));
  if (Object.keys(nuevos).length) {
    store.updateLead(numero, { datos: { ...lead.datos, ...nuevos } });
    store.addEvent(numero, 'datos', { campos: Object.keys(nuevos) });
    lead = store.getLead(numero);
  }

  const actions = [];
  const tipo = lead.handoff_at ? null : (salida.handoff || cierre);
  if (tipo) {
    const faltantes = faltantesPara(tipo, lead.datos);
    if (faltantes.length) {
      if (salida.handoff) store.addEvent(numero, 'handoff_bloqueado', { tipo, faltantes });
    } else {
      const ts = clock.nowISO();
      store.updateLead(numero, { handoff_at: ts, handoff_tipo: tipo, calificado_at: ts });
      store.addEvent(numero, 'handoff', { tipo });
      lead = store.getLead(numero);
      const nombre = lead.datos.nombre || lead.nombre_perfil || null;
      actions.push({ type: 'handoff', payload: { numero, tipo, nombre, canal: lead.canal, datos: lead.datos, enHorario: enHorario() } });
      if (config.tokko.canales.includes(lead.canal) && !lead.tokko_at) {
        actions.push({ type: 'create_tokko_contact', payload: { numero, name: nombre || 'Lead WhatsApp', phone: numero, text: comentarioTokko(lead, tipo), tags: ['WhatsApp', 'Meta Ads'], propiedad: lead.datos.propiedad || null } });
      }
    }
  }

  const texto = salida.texto || MSG_VACIO;
  const outboundId = store.commitTurn({ numero, inboundIds: pendientes.map((m) => m.id), replyText: texto });
  return { messages: [texto], actions, state: buildState(numero, store), meta: { numero, outboundId } };
}

function processPending(numero, now, deps = {}) {
  return clock.run(now, () => turno(repo.digitos(numero), deps));
}

async function handleMessage(input, deps = {}) {
  return clock.run(input.now, async () => {
    const store = deps.store || repo;
    const numero = repo.digitos(input.conversationId);
    const r = ingest(input, deps);
    if (r.decision !== 'lead') return vacio(numero, store, { decision: r.decision, motivo: r.motivo });
    const out = await turno(numero, deps);
    out.state = { ...out.state, decision: r.decision, motivo: r.motivo };
    return out;
  });
}

// Seguimientos programados. Todavía no están construidos: no devuelve nada.
async function tick(numero, now, { store = repo } = {}) {
  return clock.run(now, () => vacio(repo.digitos(numero), store));
}

module.exports = {
  ingest, processPending, handleMessage, ownerMessage, syncHistory, resolverPendiente, tick,
  parseSalida, enHorario, buildContext, toApiMessages, buildState, enObservacion,
};
