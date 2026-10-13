// Tokko Broker: carga de la consulta de un lead (la única escritura externa).
// Las propiedades NO se leen de Tokko: salen de data/propiedades.json.
const axios = require('axios');

const BASE_URL = 'https://www.tokkobroker.com/api/v1';

async function crearContacto({ name, phone, text, tags }) {
  const key = process.env.TOKKO_API_KEY;
  if (!key) throw new Error('TOKKO_API_KEY no configurada');
  const telefono = String(phone).replace(/\D/g, '').slice(-13);
  const res = await axios.post(`${BASE_URL}/webcontact/?key=${key}`, { name, phone: telefono, cellphone: telefono, email: '', text, tags }, {
    headers: { 'Content-Type': 'application/json' }, timeout: 10000,
  });
  return res.data;
}

module.exports = { crearContacto };
