// claude.js — integración con Claude API y parseo de triggers

const Anthropic = require('@anthropic-ai/sdk');
const { getSystemPrompt } = require('../prompts/vacker');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Triggers que el agente puede emitir en su respuesta
const TRIGGERS = {
  LEAD_QUALIFIED: '[LEAD_QUALIFIED]',
  HANDOFF:        '[HANDOFF_TRIGGER]',
  FOLLOWUP:       '[FOLLOWUP_TRIGGER]',
  FUTURE_DATE:    '[FUTURE_DATE]',
};

async function getReply(history) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: getSystemPrompt(),
    messages: history,
  });

  const fullText = response.content[0].text;
  const triggers = parseTriggers(fullText);
  const cleanText = removeTriggers(fullText);

  return { text: cleanText, triggers };
}

function parseTriggers(text) {
  return {
    leadQualified: text.includes(TRIGGERS.LEAD_QUALIFIED),
    handoff:       text.includes(TRIGGERS.HANDOFF),
    followup:      text.includes(TRIGGERS.FOLLOWUP),
    futureDate:    text.includes(TRIGGERS.FUTURE_DATE),
  };
}

function removeTriggers(text) {
  return Object.values(TRIGGERS)
    .reduce((t, trigger) => t.replace(trigger, ''), text)
    .trim();
}

module.exports = { getReply };
