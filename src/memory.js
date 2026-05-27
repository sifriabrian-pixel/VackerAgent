// memory.js — estado por lead y historial de conversación

const leads = {};

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
}

function addMessage(jid, role, content) {
  const lead = getLead(jid);
  lead.history.push({ role, content });
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
