// claude.js — integración con Claude API y parseo de triggers

const Anthropic = require('@anthropic-ai/sdk');
const { getSystemPrompt } = require('../prompts/vacker');
const { obtenerInventario, formatearInventarioParaPrompt } = require('./tokko');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TRIGGERS = {
  LEAD_QUALIFIED: '[LEAD_QUALIFIED]',
  HANDOFF:        '[HANDOFF_TRIGGER]',
  FOLLOWUP:       '[FOLLOWUP_TRIGGER]',
  FUTURE_DATE:    '[FUTURE_DATE]',
};

// Regex para extraer datos estructurados que Claude puede incluir
const NOMBRE_REGEX  = /\[NOMBRE:([^\]]+)\]/;
const OPERACION_REGEX = /\[OPERACION:([^\]]+)\]/;
const ZONA_REGEX    = /\[ZONA:([^\]]+)\]/;
const PRESUPUESTO_REGEX = /\[PRESUPUESTO:([^\]]+)\]/;

async function getReply(history) {
  const propiedades = await obtenerInventario();
  const inventarioTexto = formatearInventarioParaPrompt(propiedades);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: getSystemPrompt(inventarioTexto),
    messages: history,
  });

  const fullText = response.content[0].text;
  const triggers = parseTriggers(fullText);
  const leadData = parseLeadData(fullText);
  const cleanText = removeTriggers(fullText);

  return { text: cleanText, triggers, leadData };
}

function parseTriggers(text) {
  return {
    leadQualified: text.includes(TRIGGERS.LEAD_QUALIFIED),
    handoff:       text.includes(TRIGGERS.HANDOFF),
    followup:      text.includes(TRIGGERS.FOLLOWUP),
    futureDate:    text.includes(TRIGGERS.FUTURE_DATE),
  };
}

// Extrae datos del lead que Claude identifica en la conversación
function parseLeadData(text) {
  const data = {};
  const nombre = text.match(NOMBRE_REGEX);
  const operacion = text.match(OPERACION_REGEX);
  const zona = text.match(ZONA_REGEX);
  const presupuesto = text.match(PRESUPUESTO_REGEX);
  if (nombre) data.nombre = nombre[1].trim();
  if (operacion) data.operacion = operacion[1].trim();
  if (zona) data.zona = zona[1].trim();
  if (presupuesto) data.presupuesto = presupuesto[1].trim();
  return data;
}

function removeTriggers(text) {
  // Eliminar triggers y datos estructurados del texto visible
  return text
    .replace(/\[LEAD_QUALIFIED\]/g, '')
    .replace(/\[HANDOFF_TRIGGER\]/g, '')
    .replace(/\[FOLLOWUP_TRIGGER\]/g, '')
    .replace(/\[FUTURE_DATE\]/g, '')
    .replace(/\[NOMBRE:[^\]]+\]/g, '')
    .replace(/\[OPERACION:[^\]]+\]/g, '')
    .replace(/\[ZONA:[^\]]+\]/g, '')
    .replace(/\[PRESUPUESTO:[^\]]+\]/g, '')
    .trim();
}

module.exports = { getReply };
