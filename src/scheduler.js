// scheduler.js — cron jobs para follow-ups, reminders y post-visita

const cron = require('node-cron');
const { getAllLeads, getLead, updateLead } = require('./memory');
const { MENSAJES } = require('../prompts/vacker');
const { sincronizarVisitas } = require('./calendar');

const HORA_INICIO = parseInt(process.env.FOLLOWUP_HOUR_START || '9');
const HORA_FIN    = parseInt(process.env.FOLLOWUP_HOUR_END   || '18');

function enHorarioPermitido() {
  const ahora = new Date();
  const hora = ahora.getHours();
  const dia  = ahora.getDay(); // 0=domingo, 6=sábado
  const esLaborable = dia >= 1 && dia <= 5;
  return esLaborable && hora >= HORA_INICIO && hora < HORA_FIN;
}

function iniciarScheduler(sendMessage) {
  // Corre cada 30 minutos
  cron.schedule('*/30 * * * *', async () => {
    // Sincronizar visitas desde Google Calendar (siempre, no solo en horario)
    await sincronizarVisitas(getLead, updateLead).catch(err =>
      console.error('[Scheduler] Error calendar sync:', err.message)
    );

    if (!enHorarioPermitido()) return;

    const ahora = Date.now();
    const leads = getAllLeads();

    for (const lead of leads) {
      if (lead.conversacionCerrada) continue;

      const minutosDesdeUltimo = (ahora - lead.ultimoMensaje) / 1000 / 60;
      const horasDesdeUltimo   = minutosDesdeUltimo / 60;

      // ── FOLLOW-UPS ──────────────────────────────────────────────────
      if (!lead.handoffHecho && !lead.followup24Enviado && horasDesdeUltimo >= 24) {
        await sendMessage(lead.jid, MENSAJES.followup24);
        updateLead(lead.jid, { followup24Enviado: true });
        continue;
      }

      if (!lead.handoffHecho && lead.followup24Enviado && !lead.followup48Enviado && horasDesdeUltimo >= 48) {
        await sendMessage(lead.jid, MENSAJES.followup48);
        updateLead(lead.jid, { followup48Enviado: true });
        continue;
      }

      if (!lead.handoffHecho && lead.followup48Enviado && !lead.followup72Enviado && horasDesdeUltimo >= 72) {
        await sendMessage(lead.jid, MENSAJES.followup72);
        updateLead(lead.jid, { followup72Enviado: true, conversacionCerrada: true });
        continue;
      }

      // ── REMINDER PRE-VISITA ─────────────────────────────────────────
      if (lead.visitaFecha && !lead.reminderEnviado) {
        const horasHastaVisita = (lead.visitaFecha - ahora) / 1000 / 60 / 60;
        // Manda el reminder cuando faltan entre 20 y 24 horas
        if (horasHastaVisita <= 24 && horasHastaVisita > 0) {
          const fechaFormateada = lead.visitaFecha.toLocaleDateString('es-AR', {
            weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit'
          });
          await sendMessage(lead.jid, MENSAJES.reminder(fechaFormateada));
          updateLead(lead.jid, { reminderEnviado: true });
          continue;
        }
      }

      // ── POST VISITA ─────────────────────────────────────────────────
      if (lead.visitaFecha && !lead.postVisitaEnviado) {
        const horasDesdeVisita = (ahora - lead.visitaFecha) / 1000 / 60 / 60;
        // Manda el post-visita 3 horas después de la visita
        if (horasDesdeVisita >= 3) {
          await sendMessage(lead.jid, MENSAJES.postVisita);
          updateLead(lead.jid, { postVisitaEnviado: true });
          continue;
        }
      }

      // ── RECORDATORIO FECHA FUTURA ───────────────────────────────────
      if (lead.disponibleEn && !lead.recordatorioEnviado) {
        const diasHasta = (lead.disponibleEn - ahora) / 1000 / 60 / 60 / 24;
        if (diasHasta <= 1 && diasHasta > 0) {
          await sendMessage(lead.jid, `¡Hola! Te contactamos de Vacker. Hace un tiempo nos dijiste que por estas fechas ibas a tener disponibilidad para avanzar con la propiedad. ¿Seguís interesado/a? Con gusto te actualizamos las opciones. 😊`);
          updateLead(lead.jid, { recordatorioEnviado: true });
        }
      }
    }
  });

  console.log('[Scheduler] Cron iniciado — revisión cada 30 minutos');
}

module.exports = { iniciarScheduler };
