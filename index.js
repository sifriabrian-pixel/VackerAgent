// index.js — Vacker Negocios Inmobiliarios — Agente WhatsApp IA (Baileys)

require('dotenv').config();

console.log('[Config] ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY  ? 'OK' : 'FALTA');
console.log('[Config] TOKKO_API_KEY:',     process.env.TOKKO_API_KEY      ? 'OK' : 'FALTA');
console.log('[Config] TOKKO_AGENT_ID:',    process.env.TOKKO_AGENT_ID     || 'no configurado');

const http = require('http');
const { conectar, sendMessage, onMessage, getQR } = require('./src/whatsapp');
const QRCode = require('qrcode');
const { getReply }                         = require('./src/claude');
const { addMessage, getLead, updateLead, isActivated, isBlocked, blockContact, unblockContact, getAllLeads } = require('./src/memory');
const { buscarPropiedad, formatearFicha, crearContacto, buscarPorSlugPortal, interpretarSlugPortal } = require('./src/tokko');
const { iniciarScheduler }                 = require('./src/scheduler');
const { ACTIVATION_TRIGGERS, META_TRIGGERS } = require('./prompts/vacker');

const PORT = process.env.PORT || 3000;

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function esLeadInmobiliario(texto) {
  const t = texto.toLowerCase().trim();
  return ACTIVATION_TRIGGERS.some(trigger => t.includes(trigger));
}

function esCanalMeta(texto) {
  const t = texto.toLowerCase().trim();
  return META_TRIGGERS.some(trigger => t.includes(trigger));
}

// ─── PROCESAMIENTO DE MENSAJE ─────────────────────────────────────────────────

async function procesarMensaje(jid, texto) {
  if (isBlocked(jid)) {
    console.log(`[Filtro] Bloqueado (contacto personal): ${jid}`);
    return;
  }

  const yaActivado = isActivated(jid);
  if (!yaActivado && !esLeadInmobiliario(texto)) {
    console.log(`[Filtro] Ignorado (no es lead): ${jid}`);
    return;
  }

  const lead = getLead(jid);
  if (lead.conversacionCerrada) return;
  if (lead.asesorIntervino) {
    console.log(`[Filtro] Pausado por asesor: ${jid}`);
    return;
  }

  if (!lead.canal) {
    updateLead(jid, { canal: esCanalMeta(texto) ? 'meta' : 'portal' });
  }

  // Detectar fecha futura mencionada en meses
  const meses = texto.match(/(\d+)\s*meses?/i);
  if (meses && !lead.disponibleEn) {
    const fecha = new Date();
    fecha.setMonth(fecha.getMonth() + parseInt(meses[1]));
    updateLead(jid, { disponibleEn: fecha });
    console.log(`[FechaFutura] ${jid} disponible en ${meses[1]} mes(es)`);
  }

  // Detectar links de portales externos (ZonaProp, MercadoLibre, etc.)
  const { detectarPortal } = require('./src/tokko');
  const portalExterno = detectarPortal(texto);

  // Buscar propiedad en Tokko si hay link de vacker o mención directa
  let fichaTokko = null;
  let candidatosTokko = [];
  let fichaExterna = null;
  const vackerIdNuevo = texto.match(/vacker\.com\.ar\/p\/(\d+)/)?.[1];
  const esNuevaPropiedad = vackerIdNuevo && String(lead.propiedadTokkoId) !== vackerIdNuevo;

  if (portalExterno && (!lead.propiedadTokkoId || esNuevaPropiedad)) {
    // Intentar extraer dirección del slug de la URL del portal
    const urlMatch = texto.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
      const { prop, candidatos } = await buscarPorSlugPortal(urlMatch[0]);
      if (prop) {
        fichaTokko = formatearFicha(prop);
        updateLead(jid, { propiedadTokkoId: prop.id, fichaExterna: null });
        console.log(`[Portal] Propiedad encontrada via slug: ${prop.id}`);
      } else if (candidatos.length > 0) {
        candidatosTokko = candidatos;
        console.log(`[Portal] Candidatos via slug: ${candidatos.map(c => c.id).join(', ')}`);
      }
    }
  } else if (!lead.propiedadTokkoId || esNuevaPropiedad) {
    const { prop, candidatos, fichaExterna: fe } = await buscarPropiedad(texto);
    if (prop) {
      fichaTokko = formatearFicha(prop);
      updateLead(jid, { propiedadTokkoId: prop.id, fichaExterna: null });
      console.log(`[Tokko] Propiedad encontrada: ${prop.id}`);
    } else if (candidatos.length > 0) {
      candidatosTokko = candidatos;
      console.log(`[Tokko] Candidatos ambiguos: ${candidatos.map(c => c.id).join(', ')}`);
    } else if (fe) {
      fichaExterna = fe;
      updateLead(jid, { fichaExterna: fe });
    }
  }

  // Si lead ya tiene fichaExterna guardada y no se encontró otra propiedad, re-inyectarla
  if (!fichaTokko && !fichaExterna && candidatosTokko.length === 0 && lead.fichaExterna) {
    fichaExterna = lead.fichaExterna;
  }

  let mensajeParaClaude = texto;
  if (fichaTokko) {
    mensajeParaClaude += `\n\n[FICHA DE LA PROPIEDAD ENCONTRADA EN TOKKO]\n${fichaTokko}`;
  } else if (candidatosTokko.length > 0) {
    const lista = candidatosTokko.map((p, i) => {
      const ops = p.operations?.[0];
      const precio = ops?.prices?.[0] ? `${ops.prices[0].currency} ${ops.prices[0].price?.toLocaleString('es-AR')}` : 'Consultar';
      const url = `https://www.vacker.com.ar/p/${p.id}-${(p.publication_title || p.address || '').replace(/ - /g, '-').replace(/\s+/g, '-')}`;
      return `${i + 1}. ${p.address} | ${p.publication_title || '—'} | ${precio}\n   ${url}`;
    }).join('\n');
    mensajeParaClaude += `\n\n[CANDIDATOS EN TOKKO — no estoy seguro cuál es]\nEncontré varias propiedades que podrían coincidir:\n${lista}\nHacé 1 o 2 preguntas cortas para identificar cuál le interesa (tipo de propiedad, cantidad de ambientes, precio aproximado que recuerda).`;
  } else if (fichaExterna) {
    mensajeParaClaude += `\n\n[FICHA EXTERNA — propiedad pautada fuera de Tokko]\nNombre: ${fichaExterna.nombre}\nLink: ${fichaExterna.link}\nCompartí este link al lead y preguntá si le surgió alguna duda o si la busca para vivir o inversión.`;
  } else if (portalExterno) {
    const urlMatch = texto.match(/https?:\/\/[^\s]+/);
    const slugInfo = urlMatch ? interpretarSlugPortal(urlMatch[0]) : null;
    const contextoSlug = slugInfo
      ? ` Del link pude interpretar: ${slugInfo}.`
      : '';
    mensajeParaClaude += `\n\n[CONTEXTO: El lead llegó desde ${portalExterno}. No podés cargar la ficha desde ese link.${contextoSlug} Decile que los links de ${portalExterno} no te cargan la ficha completa${slugInfo ? ', usá la info del slug para dar contexto (ej: "vi que te interesa un departamento en venta en República de la Sexta")' : ''}, y pedile la dirección exacta de la propiedad.]`;
  }

  addMessage(jid, 'user', mensajeParaClaude);
  console.log(`[Mensaje] ${jid}: ${texto.substring(0, 60)}`);

  try {
    const { text: respuesta, triggers, leadData } = await getReply(getLead(jid).history);
    addMessage(jid, 'assistant', respuesta);

    const textoFinal = respuesta.replace(/\n{2,}/g, '\n').trim();
    if (textoFinal) {
      await sendMessage(jid, textoFinal);
    }

    if (Object.keys(leadData).length > 0) {
      updateLead(jid, leadData);
      console.log('[LeadData] Guardado:', leadData);
    }

    if (triggers.leadQualified && !lead.tokkoCreado) {
      const leadActual = getLead(jid);
      if (leadActual.canal === 'meta') {
        const resultado = await crearContacto(leadActual);
        if (resultado) updateLead(jid, { tokkoCreado: true, calificado: true });
      } else {
        updateLead(jid, { calificado: true });
      }
    }

    if (triggers.handoff) {
      updateLead(jid, { handoffHecho: true });
      console.log(`[Handoff] Lead ${jid} en manos del asesor`);
    }

  } catch (err) {
    console.error('[Claude] Error:', err.message);
  }
}

// ─── SERVIDOR HTTP ────────────────────────────────────────────────────────────

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);

  if (url.pathname === '/qr') {
    const qr = getQR();
    if (!qr) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body style="background:#111;color:#0f0;font-family:monospace;padding:40px"><h2>WhatsApp ya esta conectado o el QR aun no se genero.</h2><p>Recarga en unos segundos si acabas de iniciar el servidor.</p></body></html>');
      return;
    }
    const dataUrl = await QRCode.toDataURL(qr, { width: 400, margin: 2 });
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><head><meta http-equiv="refresh" content="30"><title>VackerAgent QR</title></head><body style="background:#111;color:#fff;font-family:monospace;text-align:center;padding:40px"><h2>Escaneá con WhatsApp Business de Ezequiel</h2><p>Dispositivos vinculados → Vincular un dispositivo</p><img src="${dataUrl}" style="border:8px solid white;border-radius:12px"/><p style="color:#888">Se recarga solo cada 30 segundos</p></body></html>`);
    return;
  }

  if (url.pathname === '/reset-session') {
    const { resetSession } = require('./src/whatsapp');
    await resetSession();
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body style="background:#111;color:#0f0;font-family:monospace;padding:40px"><h2>Sesión borrada.</h2><p>Entrá a <a href="/qr" style="color:#0f0">/qr</a> en 5 segundos para escanear el nuevo QR.</p></body></html>');
    return;
  }

  if (url.pathname === '/block') {
    const phone = url.searchParams.get('phone');
    if (!phone) { res.writeHead(400); res.end('Falta ?phone=549...'); return; }
    const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
    blockContact(jid);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<html><body style="background:#111;color:#0f0;font-family:monospace;padding:40px"><h2>Bloqueado: ${phone}</h2><p>El agente ya no va a responder a ese contacto.</p><p><a href="/dashboard" style="color:#0f0">← Dashboard</a></p></body></html>`);
    return;
  }

  if (url.pathname === '/unblock') {
    const phone = url.searchParams.get('phone');
    if (!phone) { res.writeHead(400); res.end('Falta ?phone=549...'); return; }
    const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
    unblockContact(jid);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<html><body style="background:#111;color:#0f0;font-family:monospace;padding:40px"><h2>Desbloqueado: ${phone}</h2><p><a href="/dashboard" style="color:#0f0">← Dashboard</a></p></body></html>`);
    return;
  }

  if (url.pathname === '/dashboard') {
    const todos = getAllLeads();
    const ahora = Date.now();

    // Filtro de período (default: 30 días)
    const dias = parseInt(url.searchParams.get('dias') || '30');
    const desde = ahora - dias * 24 * 60 * 60 * 1000;
    const leads = todos.filter(l => (l.creadoEn || 0) >= desde);

    const total       = leads.length;
    const calificados = leads.filter(l => l.calificado).length;
    const visitas     = leads.filter(l => l.visitaFecha).length;
    const handoffs    = leads.filter(l => l.handoffHecho).length;
    const deMeta      = leads.filter(l => l.canal === 'meta').length;
    const dePortal    = leads.filter(l => l.canal === 'portal').length;
    const cerrados    = leads.filter(l => l.conversacionCerrada).length;

    const convRate = total ? Math.round((calificados / total) * 100) : 0;
    const visitRate = calificados ? Math.round((visitas / calificados) * 100) : 0;

    // Tabla de leads recientes (últimos 50, más reciente primero)
    const recientes = [...todos]
      .sort((a, b) => (b.ultimoMensaje || 0) - (a.ultimoMensaje || 0))
      .slice(0, 50);

    const filas = recientes.map(l => {
      const fecha = l.creadoEn ? new Date(l.creadoEn).toLocaleDateString('es-AR') : '—';
      const ultimo = l.ultimoMensaje ? new Date(l.ultimoMensaje).toLocaleString('es-AR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }) : '—';
      const nombre = l.nombre || '—';
      const tel = l.telefono || l.jid?.replace('@s.whatsapp.net','') || '—';
      const canal = l.canal === 'meta' ? '📱 Meta' : l.canal === 'portal' ? '🏠 Portal' : '—';
      const estado = l.conversacionCerrada ? '<span style="color:#888">Cerrado</span>'
        : l.handoffHecho ? '<span style="color:#4ade80">Handoff ✓</span>'
        : l.calificado ? '<span style="color:#60a5fa">Calificado</span>'
        : '<span style="color:#fbbf24">En curso</span>';
      const visita = l.visitaFecha ? '✓' : '';
      const op = l.operacion || '—';
      const zona = l.zona || '—';
      return `<tr>
        <td>${fecha}</td>
        <td>${nombre}</td>
        <td style="font-size:12px;color:#9ca3af">${tel}</td>
        <td>${canal}</td>
        <td>${op}</td>
        <td>${zona}</td>
        <td>${estado}</td>
        <td style="text-align:center">${visita}</td>
        <td style="font-size:12px;color:#9ca3af">${ultimo}</td>
      </tr>`;
    }).join('');

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="120">
<title>Vacker Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0f1117; color: #e5e7eb; font-family: -apple-system, sans-serif; padding: 24px; }
  h1 { font-size: 22px; font-weight: 700; color: #fff; margin-bottom: 4px; }
  .sub { color: #6b7280; font-size: 13px; margin-bottom: 24px; }
  .filtros { margin-bottom: 20px; }
  .filtros a { color: #60a5fa; text-decoration: none; margin-right: 12px; font-size: 13px; }
  .filtros a.active { color: #fff; font-weight: 600; border-bottom: 2px solid #60a5fa; padding-bottom: 2px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; margin-bottom: 28px; }
  .card { background: #1c1f2b; border-radius: 10px; padding: 16px 18px; }
  .card .num { font-size: 32px; font-weight: 700; color: #fff; }
  .card .label { font-size: 12px; color: #9ca3af; margin-top: 4px; }
  .card .sub2 { font-size: 11px; color: #6b7280; margin-top: 2px; }
  .card.green .num { color: #4ade80; }
  .card.blue .num { color: #60a5fa; }
  .card.yellow .num { color: #fbbf24; }
  .card.purple .num { color: #a78bfa; }
  h2 { font-size: 15px; font-weight: 600; color: #d1d5db; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; color: #6b7280; font-weight: 500; padding: 6px 10px; border-bottom: 1px solid #1f2937; }
  td { padding: 8px 10px; border-bottom: 1px solid #111827; vertical-align: middle; }
  tr:hover td { background: #1c1f2b; }
  .wrap { background: #1c1f2b; border-radius: 10px; padding: 16px; overflow-x: auto; }
</style>
</head>
<body>
<h1>Vacker Agent — Dashboard</h1>
<p class="sub">Últimos ${dias} días · Se recarga cada 2 min</p>

<div class="filtros">
  <a href="/dashboard?dias=7" ${dias===7?'class="active"':''}>7 días</a>
  <a href="/dashboard?dias=30" ${dias===30?'class="active"':''}>30 días</a>
  <a href="/dashboard?dias=90" ${dias===90?'class="active"':''}>90 días</a>
  <a href="/dashboard?dias=9999" ${dias===9999?'class="active"':''}>Todo</a>
</div>

<div class="cards">
  <div class="card">
    <div class="num">${total}</div>
    <div class="label">Leads recibidos</div>
    <div class="sub2">Meta: ${deMeta} · Portal: ${dePortal}</div>
  </div>
  <div class="card blue">
    <div class="num">${calificados}</div>
    <div class="label">Calificados</div>
    <div class="sub2">${convRate}% del total</div>
  </div>
  <div class="card green">
    <div class="num">${visitas}</div>
    <div class="label">Visitas agendadas</div>
    <div class="sub2">${visitRate}% de calificados</div>
  </div>
  <div class="card yellow">
    <div class="num">${handoffs}</div>
    <div class="label">Handoffs a asesor</div>
    <div class="sub2">&nbsp;</div>
  </div>
  <div class="card purple">
    <div class="num">${cerrados}</div>
    <div class="label">Cerrados (sin resp.)</div>
    <div class="sub2">&nbsp;</div>
  </div>
</div>

<div class="wrap">
  <h2>Leads recientes</h2>
  <table>
    <thead>
      <tr>
        <th>Entrada</th>
        <th>Nombre</th>
        <th>Teléfono</th>
        <th>Canal</th>
        <th>Operación</th>
        <th>Zona</th>
        <th>Estado</th>
        <th>Visita</th>
        <th>Último msg</th>
      </tr>
    </thead>
    <tbody>${filas || '<tr><td colspan="9" style="color:#6b7280;text-align:center;padding:20px">Sin leads en este período</td></tr>'}</tbody>
  </table>
</div>
</body>
</html>`;

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Vacker Agent operativo');
}).listen(PORT, () => console.log(`[HTTP] Servidor en puerto ${PORT}`));

// ─── ARRANQUE ─────────────────────────────────────────────────────────────────

conectar().then(() => {
  onMessage(procesarMensaje);
  iniciarScheduler(sendMessage);
  console.log('[Agent] Vacker Agent iniciado ✓');
}).catch(err => {
  console.error('[Fatal] No se pudo conectar:', err.message);
  process.exit(1);
});
