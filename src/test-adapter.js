// Adapter de test: corre el core real sobre una base en memoria y solo
// registra las acciones. No carga ningún transporte ni Tokko: no puede enviar
// ni escribir nada afuera. Una sola instancia por proceso.
const crypto = require('crypto');
const db = require('./db');
const core = require('./core');
const llm = require('./llm');
const { buildSystemPrompt } = require('./prompt');

const CREDENCIALES = ['WHATSAPP_TOKEN', 'YCLOUD_API_KEY', 'TOKKO_API_KEY', 'GOOGLE_SERVICE_ACCOUNT_JSON'];

// paginas: { url: 'texto de la publicación' } — reemplaza la lectura de portales.
// llm: reemplazo de src/llm.js ({ chat }); por defecto, Claude real.
// observacion: por defecto false (en test interesa ver al agente responder).
function createTestAdapter({ paginas = {}, llm: llmFalso, observacion = false } = {}) {
  const presentes = CREDENCIALES.filter((k) => process.env[k]);
  if (presentes.length) throw new Error(`Adapter de test: hay credenciales reales en el entorno (${presentes.join(', ')}). Quitarlas antes de correr.`);

  db.close();
  db.open(':memory:');

  const deps = { llm: llmFalso, observacion, leerPortal: async (url) => paginas[url] || null };
  const actions = [];
  const registrar = (numero, out) => { for (const a of out.actions) actions.push({ numero, ...a }); return out; };

  return {
    actions,
    handleMessage: async (input) => registrar(input.conversationId, await core.handleMessage(input, deps)),
    tick: async (numero, now) => registrar(numero, await core.tick(numero, now, deps)),
    ownerMessage: (evento) => core.ownerMessage(evento, deps),
    syncHistory: (numeros) => core.syncHistory(numeros, deps),
    resolverPendiente: async (numero, decision) => {
      const r = core.resolverPendiente(numero, decision, deps);
      return r.ok && r.liberados ? registrar(numero, await core.processPending(numero, undefined, deps)) : r;
    },
    promptHash: () => crypto.createHash('sha256').update(buildSystemPrompt()).update(llm.MODEL).digest('hex').slice(0, 12),
    close: () => db.close(),
  };
}

module.exports = { createTestAdapter };
