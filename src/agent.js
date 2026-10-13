// Adapter de WhatsApp: recibe los eventos del proveedor, llama al core y
// ejecuta lo que el core decide (enviar mensajes, cargar el lead en Tokko).
//
// Los mensajes de un número se procesan de a uno por vez. Antes de responder
// se espera a que el lead deje de escribir, para contestar todo junto. El
// estado vive en la base: si el proceso se reinicia, recover() retoma.
const repo = require('./repo');
const core = require('./core');
const tokko = require('./tokko');
const config = require('../config/vacker');

const MAX_INTENTOS = 3;
const RETRY_BASE_MS = Number(process.env.RETRY_BASE_MS || 20000);
const esperaMs = () => Number(process.env.ESPERA_MENSAJES_MS ?? 3000);
const MSG_REINICIO = 'Conversación reiniciada. Podés empezar de nuevo.';
const MSG_ERROR = 'Perdón, tuve un problema técnico. ¿Me escribís de nuevo en unos minutos?';

let provider = null;
function setProvider(p) { provider = p; }

// ─── Acciones del core ───────────────────────────────────────────────────────

async function runActions(actions) {
  for (const { type, payload } of actions) {
    if (type !== 'create_tokko_contact') continue; // 'handoff' queda en la base para el panel
    try {
      await tokko.crearContacto(payload);
      repo.updateLead(payload.numero, { tokko_at: new Date().toISOString() });
      repo.addEvent(payload.numero, 'tokko_creado');
    } catch (e) {
      console.error(`[tokko] No se pudo cargar el lead ${payload.numero}:`, e?.response?.data || e.message);
      repo.addEvent(payload.numero, 'tokko_fallido', { error: String(e?.response?.status || e.message) });
    }
  }
}

// ─── Turno ───────────────────────────────────────────────────────────────────

async function processTurn(numero) {
  const out = await core.processPending(numero, undefined, {
    onLlmError: (e, { pendientes }) => {
      console.error(`[agent] Error de Claude para ${numero}:`, e.message);
      repo.bumpAttempts(pendientes.map((m) => m.id));
      const intentos = Math.max(...pendientes.map((m) => m.attempts)) + 1;
      repo.addEvent(numero, 'llm_error', { error: e.message, intento: intentos });
      if (intentos < MAX_INTENTOS) {
        setTimeout(() => kick(numero), RETRY_BASE_MS * intentos).unref();
        return null;
      }
      return MSG_ERROR;
    },
  });
  if (!out) return false;

  await runActions(out.actions);

  const [texto] = out.messages;
  if (!texto) return true;
  try {
    const res = await provider.sendMessage(numero, texto);
    repo.markOutbound(out.meta.outboundId, 'enviado', res?.id || null);
    repo.updateLead(numero, { ultimo_agente_at: new Date().toISOString() });
  } catch (e) {
    console.error(`[wa] Error enviando a ${numero}:`, e.message);
    repo.markOutbound(out.meta.outboundId, 'fallido');
    repo.addEvent(numero, 'envio_fallido', { error: e.message });
  }
  return true;
}

// ─── Cola por número ─────────────────────────────────────────────────────────
const enCurso = new Map();
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function esperarSilencio(numero) {
  const espera = esperaMs();
  if (!espera) return;
  const tope = Date.now() + espera * 4;
  let cantidad = repo.pendingInbound(numero).length;
  for (;;) {
    await dormir(espera);
    const ahora = repo.pendingInbound(numero).length;
    if (ahora === cantidad || Date.now() >= tope) return;
    cantidad = ahora;
  }
}

function kick(numero) {
  if (enCurso.has(numero)) {
    enCurso.get(numero).again = true;
    return enCurso.get(numero).promise;
  }
  const estado = { again: false, promise: null };
  estado.promise = (async () => {
    try {
      do {
        estado.again = false;
        if (!repo.pendingInbound(numero).length) break;
        await esperarSilencio(numero);
        if (!(await processTurn(numero))) break; // reintento programado
      } while (estado.again || repo.pendingInbound(numero).length);
    } catch (e) {
      console.error(`[agent] Error procesando ${numero}:`, e);
    } finally {
      enCurso.delete(numero);
    }
  })();
  enCurso.set(numero, estado);
  return estado.promise;
}

// ─── Eventos del proveedor ───────────────────────────────────────────────────

// Sincrónico hasta guardar: el servidor responde 200 recién después.
function handleEvents(eventos) {
  const aProcesar = new Set();
  for (const ev of eventos) {
    if (ev.kind === 'inbound') {
      if (esReinicio(ev.input)) { reset(repo.digitos(ev.input.conversationId)).catch((e) => console.error('[pruebas] Error reiniciando:', e)); continue; }
      const r = core.ingest(ev.input);
      if (r.decision === 'lead' && r.nuevo) aProcesar.add(repo.digitos(ev.input.conversationId));
    } else if (ev.kind === 'owner') {
      core.ownerMessage(ev.evento);
    } else if (ev.kind === 'history') {
      core.syncHistory(ev.numeros);
    }
  }
  for (const numero of aProcesar) kick(numero);
  return [...aProcesar];
}

// Reinicio de pruebas (config.pruebas.reiniciar). Solo vale para quien ya es un
// lead: a un contacto personal que escriba eso no se le responde nada.
function esReinicio(input) {
  const comando = config.pruebas?.reiniciar;
  if (!comando || String(input.text || '').trim().toLowerCase() !== comando) return false;
  return repo.getContacto(repo.digitos(input.conversationId))?.tipo === 'lead' && repo.marcarVisto(input.messageId);
}

async function reset(numero) {
  if (enCurso.has(numero)) await enCurso.get(numero).promise;
  repo.resetConversacion(numero);
  console.log(`[pruebas] Conversación reiniciada: ${numero}`);
  try {
    await provider.sendMessage(numero, MSG_REINICIO);
  } catch (e) {
    console.error(`[wa] Error enviando a ${numero}:`, e.message);
  }
}

// Un pendiente resuelto como lead desde el panel: se responde lo retenido.
function resolver(numero, decision) {
  const r = core.resolverPendiente(numero, decision);
  if (r.ok && r.liberados) kick(repo.digitos(numero));
  return r;
}

function recover() {
  const trabados = repo.markStuckOutbound();
  if (trabados) console.warn(`[agent] ${trabados} mensaje(s) saliente(s) quedaron sin confirmar en el reinicio anterior`);
  return Promise.all(repo.numerosConPendientes().map((n) => kick(n)));
}

const idle = () => Promise.all([...enCurso.values()].map((e) => e.promise));

module.exports = { setProvider, handleEvents, resolver, kick, recover, idle };
