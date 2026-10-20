// Utilidades de test: sin credenciales, sin esperas, LLM guionado.
process.env.WHATSAPP_DRY_RUN = '1';
process.env.RETRY_BASE_MS = '10';
process.env.ESPERA_MENSAJES_MS = '0';
process.env.PRUEBAS_REINICIAR = '1';
for (const k of ['WHATSAPP_TOKEN', 'YCLOUD_API_KEY', 'TOKKO_API_KEY', 'GOOGLE_SERVICE_ACCOUNT_JSON', 'ADMIN_TOKEN', 'WHATSAPP_APP_SECRET', 'MODO_OBSERVACION']) delete process.env[k];

const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../src/db');

// LLM falso: `respuestas` es una lista de textos (uno por llamada; el último se
// repite) o una función (historial, contexto, n) → texto.
function guion(respuestas) {
  const calls = [];
  return {
    calls,
    chat: async (historial, contexto) => {
      calls.push({ historial: JSON.parse(JSON.stringify(historial)), contexto });
      // Misma regla que aplica la API real.
      if (!historial.length || historial[0].role !== 'user') throw new Error('400: first message must use the "user" role');
      if (typeof respuestas === 'function') return respuestas(historial, contexto, calls.length);
      return respuestas[Math.min(calls.length, respuestas.length) - 1];
    },
  };
}

let n = 0;
const numero = () => `549341555${String(n += 1).padStart(4, '0')}`;
const msg = (num, text, extra = {}) => ({ conversationId: num, from: num, text, ...extra });
const ANUNCIO = { source_type: 'ad', source_id: '1202', source_url: 'https://fb.me/abc', headline: 'Casa en Funes', body: 'Sarmiento al 2400, 2 dormitorios' };
const LINK_ZP = 'https://www.zonaprop.com.ar/propiedades/clasificado/veclapin-casa-en-venta-en-funes-51234567.html';

function tmpDb() {
  db.close();
  return db.open(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vacker-test-')), 'vacker.sqlite'));
}

const cuerpos = () => db.get().prepare('SELECT cuerpo FROM mensajes').all().map((r) => r.cuerpo);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { guion, numero, msg, ANUNCIO, LINK_ZP, tmpDb, cuerpos, dormir, db };
