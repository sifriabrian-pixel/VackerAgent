// calendar.js — integración Google Calendar para visitas agendadas

const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];

function getAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const credentials = JSON.parse(raw);
    return new google.auth.GoogleAuth({ credentials, scopes: SCOPES });
  } catch (err) {
    console.error('[Calendar] Error parseando credenciales:', err.message);
    return null;
  }
}

// Extrae número de teléfono de título o descripción del evento
function extraerTelefono(texto) {
  const match = texto?.replace(/[\s\-().+]/g, '').match(/(\d{10,15})/);
  return match ? match[1] : null;
}

async function sincronizarVisitas(getLead, updateLead, getAllLeads) {
  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  if (!calendarId || !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    console.log('[Calendar] Variables no configuradas — saltando sync');
    return;
  }

  const auth = getAuth();
  if (!auth) return;

  try {
    const calendar = google.calendar({ version: 'v3', auth });
    const ahora = new Date();
    // Miramos desde 24h atrás para detectar eventos recientes que fueron borrados
    const hace24h = new Date(ahora.getTime() - 24 * 60 * 60 * 1000);
    const en14dias = new Date(ahora.getTime() + 14 * 24 * 60 * 60 * 1000);

    const res = await calendar.events.list({
      calendarId,
      timeMin: hace24h.toISOString(),
      timeMax: en14dias.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const eventos = res.data.items || [];
    console.log(`[Calendar] Sync OK — ${eventos.length} eventos`);

    // Mapa de eventIds activos en Calendar
    const eventosActivos = new Map(eventos.map(e => [e.id, e]));

    // Cargar visitas nuevas
    for (const evento of eventos) {
      const textoCompleto = `${evento.summary || ''} ${evento.description || ''}`;
      const telefono = extraerTelefono(textoCompleto);
      console.log(`[Calendar] Evento: "${evento.summary}" — teléfono extraído: ${telefono || 'ninguno'}`);
      if (!telefono) continue;

      const jids = [
        `${telefono}@s.whatsapp.net`,
        `549${telefono}@s.whatsapp.net`,
      ];

      for (const jid of jids) {
        const lead = getLead(jid);
        if (!lead?.ultimoMensaje) continue;
        if (lead.visitaFecha && lead.visitaEventId === evento.id) continue; // ya cargado

        const fechaVisita = new Date(evento.start.dateTime || evento.start.date);
        updateLead(jid, { visitaFecha: fechaVisita, visitaEventId: evento.id });
        console.log(`[Calendar] Visita cargada para ${jid}: ${fechaVisita.toLocaleString('es-AR')}`);
        break;
      }
    }

    // Detectar no-shows y visitas canceladas
    if (!getAllLeads) return;
    for (const lead of getAllLeads()) {
      if (!lead.visitaFecha || !lead.visitaEventId) continue;
      if (eventosActivos.has(lead.visitaEventId)) continue; // sigue en Calendar, todo bien

      const visitaPasada = new Date(lead.visitaFecha) < ahora;
      if (visitaPasada && !lead.postVisitaEnviado) {
        // Evento borrado y la visita ya pasó → no se presentó
        updateLead(lead.jid, { noShow: true, postVisitaEnviado: true });
        console.log(`[Calendar] No-show detectado para ${lead.jid} — post-visita omitido`);
      } else if (!visitaPasada) {
        // Evento borrado y la visita es futura → visita cancelada
        updateLead(lead.jid, { visitaFecha: null, visitaEventId: null, reminderEnviado: false });
        console.log(`[Calendar] Visita cancelada para ${lead.jid}`);
      }
    }
  } catch (err) {
    console.error('[Calendar] Error sincronizando eventos:', err.message);
  }
}

module.exports = { sincronizarVisitas };
