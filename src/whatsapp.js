// whatsapp.js — envío de mensajes vía Meta Cloud API

const axios = require('axios');

const TOKEN           = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

async function sendMessage(to, text) {
  if (!TOKEN || !PHONE_NUMBER_ID) {
    console.error('[WhatsApp] WHATSAPP_TOKEN o PHONE_NUMBER_ID no configurados');
    return;
  }
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log(`[WhatsApp] Enviado a ${to}`);
  } catch (err) {
    console.error(`[WhatsApp] Error enviando a ${to}:`, err?.response?.data || err.message);
  }
}

module.exports = { sendMessage };
