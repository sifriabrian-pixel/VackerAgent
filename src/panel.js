// Datos de solo lectura para el panel de Vacker (Ezequiel): resumen, leads y
// conversaciones. Solo hay leads: de contactos personales no se guarda nada,
// así que de esos solo se informa una cantidad.
const db = require('./db');
const config = require('../config/vacker');
const inventario = require('./inventario');
const { enObservacion } = require('./core');

// Etapa de cada lead para el panel.
//   visit_scheduled  pidió visita (derivado con propiedad y día)
//   search           búsqueda anotada (derivado sin propiedad puntual)
//   handed_off       pidió hablar con Pablo (derivación general)
//   taken            Pablo contestó a mano y el agente se corrió
//   qualified        el agente ya tiene sus datos principales
//   new              conversación en curso
function etapa(l) {
  if (l.handoff_tipo === 'agenda') return 'visit_scheduled';
  if (l.handoff_tipo === 'busqueda') return 'search';
  if (l.handoff_tipo === 'general') return 'handed_off';
  if (l.pausado_at) return 'taken';
  if (l.calificado_at) return 'qualified';
  return 'new';
}

function propiedad(ref) {
  if (!ref) return null;
  const p = inventario.porRef(ref);
  return p ? { ref: p.tokko_ref, tipo: p.tipo, direccion: p.address, barrio: p.barrio, precio: p.precio } : { ref };
}

function filaLead(r) {
  const datos = JSON.parse(r.datos || '{}');
  return {
    id: r.numero,
    telefono: `+${r.numero}`,
    nombre: datos.nombre || r.nombre_perfil || null,
    canal: r.canal,
    etapa: etapa(r),
    datos,
    propiedad: propiedad(datos.propiedad),
    anuncio: r.referral ? (JSON.parse(r.referral).headline || null) : null,
    creado_at: r.created_at,
    ultimo_mensaje_at: r.ultimo_mensaje_at || r.updated_at,
    derivado_at: r.handoff_at,
    pablo_tomo_at: r.pausado_at,
    mensajes: r.mensajes || 0,
  };
}

const SQL_LEADS = `
  SELECT l.*, c.nombre_perfil,
    (SELECT MAX(created_at) FROM mensajes m WHERE m.numero = l.numero) AS ultimo_mensaje_at,
    (SELECT COUNT(*) FROM mensajes m WHERE m.numero = l.numero AND m.cuerpo IS NOT NULL) AS mensajes
  FROM leads l JOIN contactos c ON c.numero = l.numero`;

function leads() {
  return db.get().prepare(`${SQL_LEADS} ORDER BY ultimo_mensaje_at DESC`).all().map(filaLead);
}

function lead(numero) {
  const r = db.get().prepare(`${SQL_LEADS} WHERE l.numero = ?`).get(numero);
  if (!r) return null;
  const mensajes = db.get().prepare(`
    SELECT direccion, autor, tipo, cuerpo, estado, created_at FROM mensajes
    WHERE numero = ? AND cuerpo IS NOT NULL AND estado NOT IN ('fallido') ORDER BY created_at, rowid
  `).all(numero);
  return { ...filaLead(r), mensajes };
}

function resumen() {
  const todos = leads();
  const cuenta = (f) => todos.filter(f).length;
  const filtrados = db.get().prepare(`
    SELECT COUNT(*) AS n FROM eventos WHERE tipo = 'filtro' AND json_extract(payload, '$.decision') = 'personal'
  `).get().n;
  return {
    asesor: { id: 'pablo', nombre: config.asesor.nombreCompleto, telefono: process.env.PANEL_TELEFONO_ASESOR || null },
    activo: !enObservacion(),
    leads: todos.length,
    calificados: cuenta((l) => l.etapa !== 'new'),
    visitas: cuenta((l) => l.etapa === 'visit_scheduled'),
    busquedas: cuenta((l) => l.etapa === 'search'),
    derivados: cuenta((l) => ['visit_scheduled', 'search', 'handed_off'].includes(l.etapa)),
    pablo_tomo: cuenta((l) => l.pablo_tomo_at),
    por_canal: { anuncio: cuenta((l) => l.canal === 'meta'), portal: cuenta((l) => l.canal === 'portal'), directo: cuenta((l) => l.canal === 'directo') },
    personales_filtrados: filtrados,
    ultima_actividad: todos[0]?.ultimo_mensaje_at || null,
  };
}

module.exports = { resumen, leads, lead, etapa };
