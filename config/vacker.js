// Configuración del agente de Vacker (piloto: línea de Pablo Sugamele).
module.exports = {
  asesor: { nombre: 'Pablo', nombreCompleto: 'Pablo Sugamele', inmobiliaria: 'Vacker Negocios Inmobiliarios', ciudad: 'Rosario' },
  zonaHoraria: 'America/Argentina/Buenos_Aires',
  // Atención: lunes a viernes 9 a 20, sábados 9 a 14 (hora de Argentina).
  horario: { semana: ['09:00', '20:00'], sabado: ['09:00', '14:00'] },

  // Propiedades de Pablo. Se reemplaza el archivo a mano cuando cambian.
  inventario: 'data/propiedades.json',

  filtro: {
    // Un link de estos sitios en el mensaje alcanza para tratarlo como lead.
    portales: [
      { nombre: 'Vacker', dominio: 'vacker.com.ar' },
      { nombre: 'ZonaProp', dominio: 'zonaprop.com.ar' },
      { nombre: 'Mercado Libre', dominio: 'mercadolibre.com.ar' },
      { nombre: 'Argenprop', dominio: 'argenprop.com' },
      { nombre: 'Properati', dominio: 'properati.com' },
    ],
  },

  // Qué hace falta para derivar según cómo cierra la conversación.
  // 'general' (pidió hablar conmigo, o consulta sin propiedad) no exige nada.
  derivacion: {
    agenda:   ['nombre', 'propiedad', 'disponibilidad'],
    busqueda: ['nombre', 'operacion', 'presupuesto', 'dormitorios', 'zona', 'urgencia'],
    general:  [],
  },

  // Canales cuyos leads se cargan como consulta en Tokko al derivar.
  tokko: { canales: ['meta'] },

  historialMax: 40,

  // Etapa de pruebas: un lead que escriba exactamente este mensaje arranca de
  // cero (ficha vacía, sin historial). Apagado salvo con PRUEBAS_REINICIAR=1
  // (solo en el número de prueba; nunca en la línea de Pablo).
  pruebas: { reiniciar: process.env.PRUEBAS_REINICIAR === '1' ? '#reiniciar' : null },
};
