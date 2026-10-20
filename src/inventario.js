// Propiedades de Pablo (config.inventario). Archivo fijo: se reemplaza a mano.
const fs = require('fs');
const path = require('path');
const config = require('../config/vacker');

let cache = { ruta: null, mtimeMs: 0, data: [] };

function cargar(archivo = config.inventario) {
  const ruta = path.isAbsolute(archivo) ? archivo : path.join(__dirname, '..', archivo);
  try {
    const { mtimeMs } = fs.statSync(ruta);
    if (cache.ruta !== ruta || cache.mtimeMs !== mtimeMs) cache = { ruta, mtimeMs, data: JSON.parse(fs.readFileSync(ruta, 'utf8')) };
  } catch (e) {
    console.error('[inventario] No se pudo leer el archivo de propiedades:', e.message);
    if (cache.ruta !== ruta) cache = { ruta, mtimeMs: 0, data: [] };
  }
  return cache.data;
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

function porRef(ref) {
  const r = norm(ref).replace(/\s/g, '');
  return cargar().find((p) => norm(p.tokko_ref).replace(/\s/g, '') === r) || null;
}

// Calle y altura de una dirección: "Cochabamba 12" → { calle: 'cochabamba', altura: '12' }
function partesDireccion(address) {
  const a = norm(address);
  const m = a.match(/^(.*?)(?:\s+(\d{1,5}))?$/);
  // "Alem al 4300" → calle "alem", altura "4300"
  return { calle: (m?.[1] || a).replace(/\s+al$/, '').replace(/^(av|avda|avenida|calle|bv|bulevar)\s+/, '').trim(), altura: m?.[2] || null };
}

// Identifica una propiedad a partir de un texto que la describe (título de una
// publicación, texto de un anuncio, mensaje con la dirección). No adivina:
// solo devuelve `prop` si hay UNA coincidencia clara por código, link o
// dirección. Si hay varias posibles, devuelve `candidatos` para preguntar.
function identificar(texto) {
  const t = ` ${norm(texto)} `;
  const sinEspacios = t.replace(/\s/g, '');
  const props = cargar();

  const porCodigo = props.filter((p) => p.tokko_ref && sinEspacios.includes(norm(p.tokko_ref).replace(/\s/g, '')));
  if (porCodigo.length === 1) return { prop: porCodigo[0], candidatos: [], por: 'codigo' };

  // Links o números de publicación cargados en el archivo (campo opcional "links").
  const porLink = props.filter((p) => (p.links || []).some((l) => {
    const id = String(l).match(/\d{6,}/g)?.pop();
    return id && sinEspacios.includes(id);
  }));
  if (porLink.length === 1) return { prop: porLink[0], candidatos: [], por: 'link' };

  const conCalle = props.filter((p) => {
    const { calle } = partesDireccion(p.address);
    return calle.length >= 4 && t.includes(` ${calle} `);
  });
  const conAltura = conCalle.filter((p) => {
    const { altura } = partesDireccion(p.address);
    return altura && t.includes(` ${altura} `);
  });
  if (conAltura.length === 1) return { prop: conAltura[0], candidatos: [], por: 'direccion' };
  // Solo la calle: alcanza si además coincide el tipo o el barrio. Una calle
  // suelta ("Córdoba", "San Juan") puede ser una ciudad o cualquier otra cosa.
  if (conCalle.length === 1) {
    const p = conCalle[0];
    const refuerzo = t.includes(` ${norm(p.tipo)} `) || (norm(p.barrio) && t.includes(` ${norm(p.barrio)} `));
    return refuerzo ? { prop: p, candidatos: [], por: 'calle' } : { prop: null, candidatos: [p], por: 'calle' };
  }
  if (conCalle.length > 1) return { prop: null, candidatos: conCalle.slice(0, 4), por: 'calle' };

  // Sin dirección: barrio + tipo (y operación si el texto la dice). Nunca alcanza
  // para afirmar cuál es; sirve para acotar la pregunta al lead.
  const operacion = /\balquil/.test(t) ? 'alquiler' : /\bventa\b|\bvende/.test(t) ? 'venta' : null;
  const porZona = props.filter((p) => {
    const barrio = norm(p.barrio);
    if (!barrio || !t.includes(` ${barrio} `)) return false;
    if (!t.includes(` ${norm(p.tipo)} `)) return false;
    return !operacion || norm(p.operacion) === operacion;
  });
  return { prop: null, candidatos: porZona.slice(0, 4), por: porZona.length ? 'zona' : null };
}

const dato = (v) => v !== null && v !== undefined && v !== '' && v !== 'None';

// Todos los datos de una propiedad, en texto, para que el agente arme la ficha
// y responda preguntas. Solo incluye lo que el archivo trae.
function fichaCompleta(p) {
  const lineas = [
    `Código: ${p.tokko_ref}`,
    `${p.tipo} en ${String(p.operacion).toLowerCase()} — ${p.barrio}`,
    `Dirección: ${p.address}`,
    `Precio: ${p.precio}`,
  ];
  if (dato(p.ambientes)) lineas.push(`Ambientes: ${p.ambientes}`);
  if (dato(p.dormitorios)) lineas.push(`Dormitorios: ${p.dormitorios}`);
  if (dato(p.banios)) lineas.push(`Baños: ${p.banios}`);
  if (dato(p.cocheras)) lineas.push(`Cocheras: ${p.cocheras}`);
  if (dato(p.sup_total_m2)) lineas.push(`Superficie total: ${p.sup_total_m2} m²`);
  if (dato(p.sup_cubierta_m2)) lineas.push(`Superficie cubierta: ${p.sup_cubierta_m2} m²`);
  if (dato(p.sup_terreno_m2)) lineas.push(`Terreno: ${p.sup_terreno_m2} m²`);
  if (dato(p.expensas_ars)) lineas.push(`Expensas: ARS ${Number(p.expensas_ars).toLocaleString('es-AR')}`);
  if (dato(p.adicionales)) lineas.push(`Adicionales: ${p.adicionales}`);
  if (dato(p.titulo)) lineas.push(`Título de la publicación: ${p.titulo}`);
  if (dato(p.descripcion_breve)) lineas.push(`Descripción: ${p.descripcion_breve}`);
  return lineas.join('\n');
}

function paraPrompt() {
  const props = cargar();
  if (!props.length) return 'Sin propiedades cargadas en este momento.';
  return props.map((p, i) => `PROPIEDAD ${i + 1}\n${fichaCompleta(p)}`).join('\n\n');
}

const resumen = (p) => `${p.tokko_ref}: ${p.tipo} en ${String(p.operacion).toLowerCase()}, ${p.address} (${p.barrio}), ${p.precio}`;

module.exports = { cargar, porRef, identificar, fichaCompleta, paraPrompt, resumen };
