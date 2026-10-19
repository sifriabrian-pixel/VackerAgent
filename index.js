// Agente de Vacker — servidor HTTP.
//   POST <ruta del proveedor>   webhook de WhatsApp
//   GET  /health                abierto, responde "ok"
//   /api/*                      administración; exige Authorization: Bearer <ADMIN_TOKEN>
require('dotenv').config({ quiet: true });
const http = require('http');
const crypto = require('crypto');

const db = require('./src/db');
const repo = require('./src/repo');
const core = require('./src/core');
const agent = require('./src/agent');
const inventario = require('./src/inventario');

const { agenda } = require('./src/agenda');

const PROVEEDORES = { meta: './src/adapters/meta', kapso: './src/adapters/kapso' };

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Sin ADMIN_TOKEN configurado no entra nadie.
function autorizado(req) {
  const esperado = process.env.ADMIN_TOKEN;
  if (!esperado) return false;
  const a = Buffer.from((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  const b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };

async function api(req, res, url) {
  const ruta = `${req.method} ${url.pathname}`;
  if (ruta === 'GET /api/estado') {
    return json(res, 200, {
      observacion: core.enObservacion(),
      agenda: { cargada: agenda.estaCargada(), contactos: agenda.tamano() },
      propiedades: inventario.cargar().length,
      contactos: Object.fromEntries(['lead', 'conocido', 'personal', 'bloqueado'].map((t) => [t, repo.contactosPorTipo(t).length])),
    });
  }
  if (ruta === 'GET /api/leads') return json(res, 200, repo.leads());
  // Qué decidió (o habría decidido, en modo observación) el filtro. Sin textos;
  // el número solo figura cuando la decisión fue lead.
  if (ruta === 'GET /api/filtro') return json(res, 200, repo.eventosPorTipo('filtro', Number(url.searchParams.get('limit')) || 500));

  if (req.method === 'POST') {
    let body;
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch { return json(res, 400, { error: 'JSON inválido' }); }
    const numero = repo.digitos(body.numero);
    if (!numero) return json(res, 400, { error: 'falta "numero"' });
    if (url.pathname === '/api/bloquear') { repo.borrarMensajes(numero); repo.setContacto(numero, 'bloqueado', 'manual'); return json(res, 200, { ok: true }); }
    if (url.pathname === '/api/conocido') { repo.borrarMensajes(numero); repo.setContacto(numero, 'conocido', 'manual'); return json(res, 200, { ok: true }); }
  }
  return json(res, 404, { error: 'no existe' });
}

function startServer(provider) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/health' || url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('ok');
      }

      if (url.pathname.startsWith('/api/')) {
        if (!autorizado(req)) return json(res, 401, { error: 'No autorizado' });
        return await api(req, res, url);
      }

      if (url.pathname === provider.ruta && req.method === 'GET') {
        const ok = url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === process.env.WHATSAPP_VERIFY_TOKEN;
        res.writeHead(ok ? 200 : 403, { 'Content-Type': 'text/plain' });
        return res.end(ok ? url.searchParams.get('hub.challenge') : 'Forbidden');
      }

      if (url.pathname === provider.ruta && req.method === 'POST') {
        const raw = await readBody(req);
        if (!provider.verifySignature(raw, req.headers)) {
          console.error('[webhook] Firma inválida — rechazado');
          res.writeHead(403);
          return res.end();
        }
        let payload;
        try { payload = JSON.parse(raw.toString('utf8')); } catch { res.writeHead(400); return res.end(); }
        // Se guarda ANTES de responder 200: si falla, el proveedor reintenta.
        agent.handleEvents(provider.parseWebhook(payload));
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('OK');
      }

      res.writeHead(404);
      return res.end();
    } catch (e) {
      console.error('[server] Error:', e);
      if (!res.headersSent) res.writeHead(500);
      return res.end();
    }
  });
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`[server] Escuchando en puerto ${server.address().port}`));
  return server;
}

function cargarProveedor() {
  const nombre = process.env.WHATSAPP_PROVIDER || 'meta';
  if (!PROVEEDORES[nombre]) throw new Error(`WHATSAPP_PROVIDER desconocido: ${nombre}`);
  return require(PROVEEDORES[nombre]);
}

if (require.main === module) {
  const provider = cargarProveedor();
  const faltan = ['ANTHROPIC_API_KEY', 'ADMIN_TOKEN', ...(provider.nombre === 'kapso' ? ['KAPSO_API_KEY', 'KAPSO_PHONE_NUMBER_ID', 'KAPSO_WEBHOOK_SECRET'] : [])].filter((k) => !process.env[k]);
  if (faltan.length) console.warn(`[config] Faltan variables: ${faltan.join(', ')}`);
  console.log(`[config] Proveedor de WhatsApp: ${provider.nombre}`);
  console.log(`[config] Modo observación: ${core.enObservacion() ? 'SÍ — el agente no responde a nadie (MODO_OBSERVACION=false para activarlo)' : 'no — el agente responde a los leads'}`);
  if (!process.env.RAILWAY_VOLUME_MOUNT_PATH && !process.env.DB_PATH) console.warn('[config] Sin volumen: los datos se pierden en cada deploy');
  db.open();
  console.log(`[inventario] ${inventario.cargar().length} propiedades cargadas`);
  agent.setProvider(provider);
  agent.recover();
  agent.cargarAgenda();
  const server = startServer(provider);

  process.on('SIGTERM', () => {
    console.log('[server] SIGTERM — cerrando');
    server.close();
    agent.idle().finally(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 8000).unref();
  });
}

module.exports = { startServer };
