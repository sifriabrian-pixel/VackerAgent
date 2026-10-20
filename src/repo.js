// Acceso a datos. Todo el estado del agente vive en la base (en el volumen).
const crypto = require('crypto');
const db = require('./db');
const clock = require('./clock');

const now = clock.nowISO;
const uuid = () => crypto.randomUUID();
const digitos = (s) => String(s || '').replace(/\D/g, '');

// ─── Contactos ───────────────────────────────────────────────────────────────

function getContacto(numero) {
  return db.get().prepare('SELECT * FROM contactos WHERE numero = ?').get(numero) || null;
}

function setContacto(numero, tipo, origen, nombrePerfil = null) {
  const ts = now();
  db.get().prepare(`
    INSERT INTO contactos (numero, tipo, origen, nombre_perfil, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (numero) DO UPDATE SET tipo = excluded.tipo, origen = excluded.origen,
      nombre_perfil = COALESCE(excluded.nombre_perfil, contactos.nombre_perfil), updated_at = excluded.updated_at
  `).run(numero, tipo, origen, nombrePerfil, ts, ts);
  return getContacto(numero);
}

function contactosPorTipo(tipo) {
  return db.get().prepare('SELECT * FROM contactos WHERE tipo = ? ORDER BY updated_at DESC').all(tipo);
}

// ─── Leads ───────────────────────────────────────────────────────────────────

function parseLead(row) {
  if (!row) return null;
  return { ...row, datos: JSON.parse(row.datos || '{}'), referral: row.referral ? JSON.parse(row.referral) : null };
}

function getLead(numero) {
  return parseLead(db.get().prepare(`
    SELECT l.*, c.nombre_perfil FROM leads l JOIN contactos c ON c.numero = l.numero WHERE l.numero = ?
  `).get(numero));
}

function createLead(numero, { canal, referral = null }) {
  const ts = now();
  db.get().prepare(`
    INSERT INTO leads (numero, canal, referral, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (numero) DO NOTHING
  `).run(numero, canal, referral ? JSON.stringify(referral) : null, ts, ts);
  return getLead(numero);
}

const CAMPOS_LEAD = ['canal', 'datos', 'calificado_at', 'handoff_at', 'handoff_tipo', 'pausado_at', 'cerrado_at', 'tokko_at', 'ultimo_lead_at', 'ultimo_agente_at'];

function updateLead(numero, campos) {
  const claves = Object.keys(campos).filter((k) => CAMPOS_LEAD.includes(k));
  if (!claves.length) return;
  const valores = claves.map((k) => (k === 'datos' ? JSON.stringify(campos[k]) : campos[k]));
  db.get().prepare(`UPDATE leads SET ${claves.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE numero = ?`).run(...valores, now(), numero);
}

function leads() {
  return db.get().prepare(`
    SELECT l.*, c.nombre_perfil FROM leads l JOIN contactos c ON c.numero = l.numero ORDER BY l.updated_at DESC
  `).all().map(parseLead);
}

// ─── Mensajes ────────────────────────────────────────────────────────────────

// Filtro de duplicados: true la primera vez que se ve ese id del proveedor.
function marcarVisto(proveedorId) {
  if (!proveedorId) return true;
  return db.get().prepare('INSERT INTO vistos (proveedor_id, created_at) VALUES (?, ?) ON CONFLICT DO NOTHING').run(proveedorId, now()).changes === 1;
}

function insertMensaje({ numero, direccion, autor, proveedorId = null, tipo = 'text', cuerpo, estado }) {
  const id = uuid();
  db.get().prepare(`
    INSERT INTO mensajes (id, numero, direccion, autor, proveedor_id, tipo, cuerpo, estado, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, numero, direccion, autor, proveedorId, tipo, cuerpo, estado, now());
  return id;
}

function pendingInbound(numero) {
  return db.get().prepare("SELECT * FROM mensajes WHERE numero = ? AND direccion = 'in' AND estado = 'pendiente' ORDER BY created_at, rowid").all(numero);
}

function numerosConPendientes() {
  return db.get().prepare("SELECT DISTINCT numero FROM mensajes WHERE direccion = 'in' AND estado = 'pendiente'").all().map((r) => r.numero);
}

// No era un lead: no se conserva nada de lo que escribió.
function borrarMensajes(numero) {
  return db.get().prepare('DELETE FROM mensajes WHERE numero = ?').run(numero).changes;
}

function bumpAttempts(ids) {
  const stmt = db.get().prepare('UPDATE mensajes SET attempts = attempts + 1 WHERE id = ?');
  db.get().transaction(() => ids.forEach((id) => stmt.run(id)))();
}

// Reinicio de pruebas: el lead arranca de cero sin borrar nada. La ficha se
// vacía (queda copiada en el evento) y el historial que ve el agente empieza
// después de este punto.
function resetConversacion(numero) {
  const conn = db.get();
  return conn.transaction(() => {
    const lead = getLead(numero);
    if (!lead) return false;
    conn.prepare("UPDATE mensajes SET estado = 'procesado', processed_at = ? WHERE numero = ? AND direccion = 'in' AND estado = 'pendiente'").run(now(), numero);
    const desde = conn.prepare('SELECT COALESCE(MAX(rowid), 0) AS n FROM mensajes WHERE numero = ?').get(numero).n;
    conn.prepare("UPDATE leads SET datos = '{}', calificado_at = NULL, handoff_at = NULL, handoff_tipo = NULL, pausado_at = NULL, cerrado_at = NULL, updated_at = ? WHERE numero = ?").run(now(), numero);
    addEvent(numero, 'conversation_reset', { desde_mensaje: desde, datos_anteriores: lead.datos });
    return true;
  })();
}

function inicioHistorial(numero) {
  const row = db.get().prepare("SELECT payload FROM eventos WHERE numero = ? AND tipo = 'conversation_reset' ORDER BY rowid DESC LIMIT 1").get(numero);
  return row ? JSON.parse(row.payload).desde_mensaje : 0;
}

// Últimos N mensajes de la conversación (ya procesados), en orden.
function history(numero, limit) {
  return db.get().prepare(`
    SELECT * FROM (
      SELECT rowid AS rid, * FROM mensajes
      WHERE numero = ? AND rowid > ? AND cuerpo IS NOT NULL AND estado NOT IN ('pendiente', 'retenido', 'fallido')
      ORDER BY created_at DESC, rowid DESC LIMIT ?
    ) ORDER BY created_at, rid
  `).all(numero, inicioHistorial(numero), limit);
}

// Cierra un turno de forma atómica: entrantes procesados + respuesta en 'enviando'.
function commitTurn({ numero, inboundIds, replyText }) {
  const conn = db.get();
  const ts = now();
  let outId = null;
  conn.transaction(() => {
    const mark = conn.prepare("UPDATE mensajes SET estado = 'procesado', processed_at = ? WHERE id = ?");
    inboundIds.forEach((id) => mark.run(ts, id));
    if (replyText) outId = insertMensaje({ numero, direccion: 'out', autor: 'agente', cuerpo: replyText, estado: 'enviando' });
  })();
  return outId;
}

function markOutbound(id, estado, proveedorId = null) {
  db.get().prepare('UPDATE mensajes SET estado = ?, proveedor_id = COALESCE(?, proveedor_id) WHERE id = ?').run(estado, proveedorId, id);
}

function esMensajeDelAgente(proveedorId) {
  if (!proveedorId) return false;
  return Boolean(db.get().prepare("SELECT 1 FROM mensajes WHERE proveedor_id = ? AND autor = 'agente'").get(proveedorId));
}

function markStuckOutbound() {
  return db.get().prepare("UPDATE mensajes SET estado = 'desconocido' WHERE direccion = 'out' AND estado = 'enviando'").run().changes;
}

// ─── Eventos ─────────────────────────────────────────────────────────────────

function addEvent(numero, tipo, payload = null) {
  db.get().prepare('INSERT INTO eventos (id, numero, tipo, payload, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(uuid(), numero, tipo, payload == null ? null : JSON.stringify(payload), now());
}

function events(numero) {
  return db.get().prepare('SELECT * FROM eventos WHERE numero = ? ORDER BY created_at, rowid').all(numero)
    .map((e) => ({ ...e, payload: e.payload ? JSON.parse(e.payload) : null }));
}

function eventosPorTipo(tipo, limit = 500) {
  return db.get().prepare('SELECT * FROM eventos WHERE tipo = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(tipo, limit)
    .map((e) => ({ ...e, payload: e.payload ? JSON.parse(e.payload) : null }));
}

module.exports = {
  digitos, getContacto, setContacto, contactosPorTipo,
  getLead, createLead, updateLead, leads,
  marcarVisto, insertMensaje, pendingInbound, numerosConPendientes, borrarMensajes,
  bumpAttempts, history, resetConversacion, commitTurn, markOutbound, esMensajeDelAgente, markStuckOutbound,
  addEvent, events, eventosPorTipo,
};
