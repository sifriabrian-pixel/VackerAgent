# Agente de Vacker

Agente de WhatsApp para Vacker Negocios Inmobiliarios (piloto: línea de Pablo Sugamele).
Atiende solo a leads; nunca a los contactos personales del asesor.

## Cómo está armado

| Archivo | Qué hace |
|---|---|
| `config/vacker.js` | Asesor, horarios, portales, datos requeridos para derivar |
| `data/propiedades.json` | Las propiedades de Pablo. Se reemplaza a mano |
| `src/core.js` | Toda la lógica, sin transporte: devuelve `{ messages, actions, state }` y nunca envía |
| `src/filtro.js` | Decide lead / personal para cada mensaje entrante |
| `src/agenda.js` | Agenda del teléfono del asesor, solo en memoria (la fuente es Kapso) |
| `src/inventario.js` · `src/portales.js` | Identifican de qué propiedad habla un anuncio, un link o un mensaje (sin adivinar) |
| `src/prompt.js` · `src/llm.js` | Prompt (Pablo en primera persona, con las propiedades) y llamada a Claude |
| `src/agent.js` | Adapter: cola por número, espera de mensajes seguidos, envío, carga en Tokko |
| `src/adapters/kapso.js` | Transporte: Kapso con coexistencia (línea de Pablo) |
| `src/adapters/meta.js` | Transporte: WhatsApp Cloud API de Meta (número de prueba) |
| `src/test-adapter.js` | Core real sobre SQLite en memoria; registra las acciones sin ejecutarlas (QA) |
| `src/repo.js` · `src/db.js` | SQLite en el volumen y migraciones (`db/migrations`) |

## Filtro

Pablo agenda a todos los que conoce: un número que no está en su agenda es un lead.

1. Un mensaje del asesor nunca es un lead. En una conversación del agente, lo pausa; a un número que no tiene agendado, lo deja como **conocido** (solo el número).
2. Bloqueado → se ignora. Lead activo → sigue la conversación.
3. Conocido (chat previo o el asesor le escribió primero) → no se responde.
4. Agenda todavía sin cargar → no se responde a nadie nuevo.
5. Está en la agenda → no se responde, aunque mande un link o venga de un anuncio.
6. Cualquier otro número → **lead** (canal: anuncio, portal o directo).

De quien no es lead no se guarda nada: ni el texto, ni el nombre, ni el número
(salvo el número suelto del punto 1 y de los chats previos).

## Modo observación

Activado por defecto: el agente registra qué decidiría el filtro (`/api/filtro`) pero no
responde ni guarda mensajes. Se apaga con `MODO_OBSERVACION=false`.

## Administración

Todo con `Authorization: Bearer $ADMIN_TOKEN`:
`GET /api/estado`, `GET /api/leads`, `GET /api/filtro`, `POST /api/bloquear {numero}`, `POST /api/conocido {numero}`.
`GET /health` es abierto.

## Pruebas

`PRUEBAS_REINICIAR=1` habilita el comando `#reiniciar` (un lead arranca de cero). Solo en el número de prueba.

## Tests

```bash
npm test
```

## Pendiente

- Conectar la línea de Pablo: ver [docs/CONECTAR-LINEA-PABLO.md](docs/CONECTAR-LINEA-PABLO.md).
- Seguimientos automáticos (`core.tick`) y visitas de Calendar.
