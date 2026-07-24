// config/pautadas.js — propiedades actualmente pautadas en Meta Ads
//
// keywords: cualquier combinación de estas palabras en el mensaje activa el match
//   - array simple: TODAS deben estar presentes (AND)
//   - matchAny: true → alcanza con UNA (OR)
// address: palabras de la dirección real (se agregan al matching automáticamente)
// tokkoId: ID en Tokko → buscamos ficha completa
// link: para propiedades fuera de Tokko (ficha.info, etc.)

module.exports = [
  {
    keywords: ['alberdi'],
    tokkoId: '7936621',
  },
  {
    keywords: ['aguadas'],
    tokkoId: '8052198',
  },
  {
    keywords: ['roldan', 'roldán'],
    matchAny: true,
    tokkoId: '3731675',
  },
  {
    keywords: ['alem', '1200'],
    tokkoId: '8071766',
  },
  {
    keywords: ['villalobos'],
    tokkoId: '8089133',
  },
  {
    keywords: ['tierra de sue'],
    tokkoId: '8019036',
  },
  {
    keywords: ['nave', 'ruta 21'],
    matchAny: true,
    tokkoId: '6898249',
  },
  {
    keywords: ['ingenieros'],
    nombre: 'Lote Jose Ingenieros',
    address: ['jose ingenieros'],
    link: 'https://ficha.info/p/60a4f5a0ab904e968191bb069a49065f?v=1770296209205',
  },
  {
    keywords: ['san luis'],
    nombre: 'San Luis al 900',
    address: ['san luis', '900'],
    tokkoId: '7554555',
  },
  {
    keywords: ['cerrito'],
    nombre: 'Cerrito',
    address: ['cerrito'],
    link: 'https://ficha.info/p/50e48c293daa435ebc548dffc33bc125?v=1768491926646',
  },
];
