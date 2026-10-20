// Llamada a Claude. Una llamada por turno: devuelve el texto tal cual lo
// escribió el modelo (con etiquetas); interpretarlas es trabajo del core.
const Anthropic = require('@anthropic-ai/sdk');
const { buildSystemPrompt } = require('./prompt');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}
// Para tests: inyectar un cliente falso con la misma forma (messages.create).
function setClient(c) { client = c; }

// contexto: texto del turno (propiedad identificada, datos capturados, horario).
// Va en un bloque aparte, sin cache, porque cambia en cada llamada.
async function chat(historial, contexto) {
  const system = [{ type: 'text', text: buildSystemPrompt(), cache_control: { type: 'ephemeral' } }];
  if (contexto) system.push({ type: 'text', text: contexto });
  const response = await getClient().messages.create({ model: MODEL, max_tokens: 1024, system, messages: historial });
  return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

module.exports = { chat, setClient, MODEL };
