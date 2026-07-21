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

async function sincronizarVisitas(getLead, updateLead) {
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
    const en14dias = new Date(ahora.getTime() + 14 * 24 * 60 * 60 * 1000);

    const res = await calendar.events.list({
      calendarId,
      timeMin: ahora.toISOString(),
      timeMax: en14dias.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const eventos = res.data.items || [];
    console.log(`[Calendar] Sync OK — ${eventos.length} eventos en los próximos 14 días`);

    for (const evento of eventos) {
      const textoCompleto = `${evento.summary || ''} ${evento.description || ''}`;
      const telefono = extraerTelefono(textoCompleto);
      console.log(`[Calendar] Evento: "${evento.summary}" — teléfono extraído: ${telefono || 'ninguno'}`);
      if (!telefono) continue;

      // Intentar con y sin código de país
      const jids = [
        `${telefono}@s.whatsapp.net`,
        `549${telefono}@s.whatsapp.net`,  // Argentina sin prefijo
      ];

      for (const jid of jids) {
        const lead = getLead(jid);
        if (!lead?.ultimoMensaje) continue; // no es un lead conocido
        if (lead.visitaFecha) continue;     // ya tiene fecha cargada

        const fechaVisita = new Date(evento.start.dateTime || evento.start.date);
        updateLead(jid, { visitaFecha: fechaVisita });
        console.log(`[Calendar] Visita cargada para ${jid}: ${fechaVisita.toLocaleString('es-AR')}`);
        break;
      }
    }
  } catch (err) {
    console.error('[Calendar] Error sincronizando eventos:', err.message);
  }
}

module.exports = { sincronizarVisitas };
