# Agente de Vacker

Agente de WhatsApp para Vacker Negocios Inmobiliarios (piloto: línea de Pablo Sugamele).
Atiende solo a leads; nunca a los contactos personales del asesor.

## Cómo está armado

| Archivo | Qué hace |
|---|---|
| `config/vacker.js` | Asesor, horarios, portales, datos requeridos para derivar |
| `data/propiedades.json` | Las propiedades de Pablo. Se reemplaza a mano |
| `src/core.js` | Toda la lógica, sin transporte: devuelve `{ messages, actions, state }` y nunca envía |
| `src/filtro.js` | Decide lead / personal / pendiente para cada mensaje entrante |
| `src/inventario.js` · `src/portales.js` | Identifican de qué propiedad habla un anuncio, un link o un mensaje (sin adivinar) |
| `src/prompt.js` · `src/llm.js` | Prompt (Pablo en primera persona, con las propiedades) y llamada a Claude |
| `src/agent.js` | Adapter: cola por número, espera de mensajes seguidos, envío, carga en Tokko |
| `src/adapters/meta.js` | Transporte: WhatsApp Cloud API de Meta (número de prueba) |
| `src/test-adapter.js` | Core real sobre SQLite en memoria; registra las acciones sin ejecutarlas (QA) |
| `src/repo.js` · `src/db.js` | SQLite en el volumen y migraciones (`db/migrations`) |

## Filtro

1. Un mensaje del asesor nunca es un lead. En una conversación del agente, lo pausa; en cualquier otro chat, deja ese número como **conocido**.
2. Bloqueado → se ignora. Lead activo → sigue la conversación.
3. Conocido (historial o el asesor le escribió) → no se responde ni se guarda el texto. Si entra por un anuncio → pendiente.
4. Viene de un anuncio (metadata) → lead.
5. Trae un link de un portal → lead.
6. Sin señal → **pendiente**: no se responde hasta que alguien lo resuelva (`/api/pendientes`).

## Modo observación

Activado por defecto: el agente registra qué decidiría el filtro (`/api/filtro`) pero no
responde ni guarda mensajes. Se apaga con `MODO_OBSERVACION=false`.

## Administración

Todo con `Authorization: Bearer $ADMIN_TOKEN`:
`GET /api/estado`, `GET /api/leads`, `GET /api/pendientes`, `GET /api/filtro`,
`POST /api/pendientes/resolver {numero, decision}`, `POST /api/bloquear {numero}`, `POST /api/conocido {numero}`.
`GET /health` es abierto.

## Tests

```bash
npm test
```

## Pendiente

- Transporte YCloud (coexistencia) para la línea de Pablo.
- Clasificador para los mensajes sin señal (hoy quedan todos pendientes).
- Seguimientos automáticos (`core.tick`) y visitas de Calendar.
