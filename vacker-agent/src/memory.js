// memory.js — estado por lead y historial de conversación

const leads = {};

function getLead(jid) {
  if (!leads[jid]) {
    leads[jid] = {
      jid,
      history: [],
      // Datos del lead
      nombre: null,
      telefono: jid.replace('@s.whatsapp.net', ''),
      operacion: null,       // 'venta' | 'alquiler'
      zona: null,
      ambientes: null,
      presupuesto: null,
      propiedadInteres: null, // ID de propiedad del inventario
      // Estados
      calificado: false,
      handoffHecho: false,
      tokkoCreado: false,
      // Visita
      visitaFecha: null,      // Date object
      reminderEnviado: false,
      postVisitaEnviado: false,
      // Follow-up
      ultimoMensaje: Date.now(),
      followup24Enviado: false,
      followup48Enviado: false,
      conversacionCerrada: false,
      // Fecha futura (lead que tiene dinero en X meses)
      disponibleEn: null,     // Date object
      recordatorioEnviado: false,
    };
  }
  return leads[jid];
}

function updateLead(jid, data) {
  const lead = getLead(jid);
  Object.assign(lead, data);
  lead.ultimoMensaje = Date.now();
}

function addMessage(jid, role, content) {
  const lead = getLead(jid);
  lead.history.push({ role, content });
  // Mantener solo los últimos 20 mensajes para no inflar tokens
  if (lead.history.length > 20) {
    lead.history = lead.history.slice(-20);
  }
  lead.ultimoMensaje = Date.now();
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
