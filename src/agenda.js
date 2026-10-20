// Agenda del teléfono del asesor (los contactos que tiene guardados en
// WhatsApp Business). Pablo agenda a todos los que conoce: un número que no
// está en la agenda es, muy probablemente, un lead.
//
// Vive solo en memoria: no se guarda en la base. La fuente es el proveedor
// (Kapso la importa del teléfono al conectar el número y avisa cada alta o
// baja); al arrancar se vuelve a pedir entera.
//
// Mientras no está cargada, el filtro no trata a nadie como lead: sin agenda
// no hay forma de distinguir a un amigo de un cliente.

// Los celulares de Argentina a veces llegan sin el 9 (54 341…) y otras con él
// (54 9 341…). Se guardan y se buscan siempre con el 9.
function normalizar(crudo) {
  let n = String(crudo || '').replace(/\D/g, '');
  if (/^54\d{10}$/.test(n)) n = `549${n.slice(2)}`;
  return n;
}

// Una tanda de bajas grande no es Pablo borrando contactos a mano: Meta a veces
// manda lotes de "remove" que no corresponden (problema conocido de Kapso).
// Sacar a alguien de la agenda lo convierte en posible lead, así que esas
// tandas se ignoran: lo peor que pasa es que el agente no le hable a alguien.
const MAX_BAJAS_POR_TANDA = 5;

function crearAgenda() {
  let numeros = new Set();
  let cargada = false;

  return {
    normalizar,
    estaCargada: () => cargada,
    tamano: () => numeros.size,
    tiene: (numero) => numeros.has(normalizar(numero)),

    // Carga completa (al arrancar). Reemplaza lo que hubiera.
    reemplazar(lista) {
      numeros = new Set(lista.map(normalizar).filter(Boolean));
      cargada = true;
      return numeros.size;
    },

    // cambios: [{ numero, accion: 'add' | 'remove' }]
    aplicar(cambios) {
      const bajas = cambios.filter((c) => c.accion === 'remove');
      const ignorarBajas = bajas.length > MAX_BAJAS_POR_TANDA;
      let altas = 0;
      let quitados = 0;
      for (const { numero, accion } of cambios) {
        const n = normalizar(numero);
        if (!n) continue;
        if (accion === 'add') { if (!numeros.has(n)) altas += 1; numeros.add(n); }
        if (accion === 'remove' && !ignorarBajas && numeros.delete(n)) quitados += 1;
      }
      return { altas, bajas: quitados, bajasIgnoradas: ignorarBajas ? bajas.length : 0 };
    },
  };
}

module.exports = { crearAgenda, normalizar, MAX_BAJAS_POR_TANDA, agenda: crearAgenda() };
