// memory.js — estado por lead y historial de conversación

const fs = require('fs');
const path = require('path');

const DATA_DIR  = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const LEADS_FILE = path.join(DATA_DIR, 'leads.json');

// Cargar leads persistidos al arranque
const leads = (() => {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(LEADS_FILE)) {
      const raw = fs.readFileSync(LEADS_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      // Rehidratar fechas (JSON.parse las convierte a string)
      for (const lead of Object.values(parsed)) {
        if (lead.visitaFecha)   lead.visitaFecha   = new Date(lead.visitaFecha);
        if (lead.disponibleEn)  lead.disponibleEn  = new Date(lead.disponibleEn);
      }
      console.log(`[Memory] ${Object.keys(parsed).length} leads cargados desde disco`);
      return parsed;
    }
  } catch (err) {
    console.error('[Memory] Error cargando leads:', err.message);
  }
  return {};
})();

let saveTimer = null;
function schedulesSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2), 'utf8');
    } catch (err) {
      console.error('[Memory] Error guardando leads:', err.message);
    }
  }, 2000); // guarda 2 seg después del último cambio
}

function getLead(jid) {
  if (!leads[jid]) {
    leads[jid] = {
      jid,
      history: [],
      // Datos del lead
      nombre: null,
      telefono: jid.replace('@s.whatsapp.net', '').replace('@lid', ''),
      operacion: null,
      zona: null,
      ambientes: null,
      presupuesto: null,
      propiedadInteres: null,
      propiedadTokkoId: null,
      // Estados
      calificado: false,
      handoffHecho: false,
      tokkoCreado: false,
      asesorIntervino: false,
      // Visita
      visitaFecha: null,
      reminderEnviado: false,
      postVisitaEnviado: false,
      // Follow-up
      ultimoMensaje: Date.now(),
      followup24Enviado: false,
      followup48Enviado: false,
      followup72Enviado: false,
      conversacionCerrada: false,
      // Fecha futura
      disponibleEn: null,
      recordatorioEnviado: false,
      // Canal de origen
      canal: null, // 'meta' | 'portal'
    };
  }
  return leads[jid];
}

function updateLead(jid, data) {
  const lead = getLead(jid);
  Object.assign(lead, data);
  lead.ultimoMensaje = Date.now();
  schedulesSave();
}

function addMessage(jid, role, content) {
  const lead = getLead(jid);
  lead.history.push({ role, content });
  if (lead.history.length > 20) {
    lead.history = lead.history.slice(-20);
  }
  lead.ultimoMensaje = Date.now();
  schedulesSave();
}

function getHistory(jid) {
  return getLead(jid).history;
}

function getAllLeads() {
  return Object.values(leads);
}

function isActivated(jid) {
  const lead = leads[jid];
  return lead && lead.history.length > 0;
}

module.exports = { getLead, updateLead, addMessage, getHistory, getAllLeads, isActivated };
