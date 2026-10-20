-- Esquema del agente de Vacker. Solo TEXT / INTEGER (compatible con Postgres).
-- Los números van solo con dígitos (5493415550001), sin + ni sufijos.

-- Todo número que alguna vez escribió o al que el asesor le escribió.
--   lead      → el agente conversa con él
--   conocido  → contacto del asesor (historial sincronizado o el asesor le escribió): nunca se responde
--   personal  → se decidió que no es un lead: nunca se responde
--   pendiente → no se pudo decidir: no se responde hasta que alguien lo resuelva
--   bloqueado → bloqueado a mano
CREATE TABLE contactos (
  numero        TEXT PRIMARY KEY,
  tipo          TEXT NOT NULL CHECK (tipo IN ('lead', 'conocido', 'personal', 'pendiente', 'bloqueado')),
  origen        TEXT,
  nombre_perfil TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE leads (
  numero           TEXT PRIMARY KEY REFERENCES contactos (numero),
  canal            TEXT CHECK (canal IN ('meta', 'portal', 'directo')),
  referral         TEXT,
  datos            TEXT NOT NULL DEFAULT '{}',
  calificado_at    TEXT,
  handoff_at       TEXT,
  handoff_tipo     TEXT,
  pausado_at       TEXT,
  cerrado_at       TEXT,
  tokko_at         TEXT,
  ultimo_lead_at   TEXT,
  ultimo_agente_at TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

-- Solo se guarda el texto de leads y de pendientes. De conocidos y
-- personales no se guarda ningún mensaje.
CREATE TABLE mensajes (
  id           TEXT PRIMARY KEY,
  numero       TEXT NOT NULL,
  direccion    TEXT NOT NULL CHECK (direccion IN ('in', 'out')),
  autor        TEXT NOT NULL CHECK (autor IN ('lead', 'agente', 'asesor')),
  proveedor_id TEXT UNIQUE,
  tipo         TEXT NOT NULL,
  cuerpo       TEXT,
  -- in:  retenido (pendiente de decisión) | pendiente -> procesado
  -- out: enviando -> enviado | fallido | desconocido ; registrado (lo escribió el asesor)
  estado       TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  processed_at TEXT
);
CREATE INDEX mensajes_numero_idx ON mensajes (numero, created_at);
CREATE INDEX mensajes_estado_idx ON mensajes (direccion, estado);

-- Filtro de duplicados para todo lo que entra (sin contenido).
CREATE TABLE vistos (
  proveedor_id TEXT PRIMARY KEY,
  created_at   TEXT NOT NULL
);

CREATE TABLE eventos (
  id         TEXT PRIMARY KEY,
  numero     TEXT,
  tipo       TEXT NOT NULL,
  payload    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX eventos_numero_idx ON eventos (numero, created_at);
CREATE INDEX eventos_tipo_idx ON eventos (tipo, created_at);
