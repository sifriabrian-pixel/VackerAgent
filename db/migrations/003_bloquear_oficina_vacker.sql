-- Bloquea el número de la oficina de Vacker Negocios Inmobiliarios.
-- Este número fue clasificado erróneamente como lead y recibió seguimientos.
-- Se marca como bloqueado para que el agente y el scheduler lo ignoren siempre.

INSERT INTO contactos (numero, tipo, origen, nombre_perfil, created_at, updated_at)
VALUES (
  '5493417182512',
  'bloqueado',
  'manual',
  'Vacker Negocios Inmobiliarios (oficina)',
  datetime('now'),
  datetime('now')
)
ON CONFLICT (numero) DO UPDATE SET
  tipo       = 'bloqueado',
  updated_at = datetime('now');

-- Si hay un lead asociado, pausarlo permanentemente para que el scheduler no lo procese
UPDATE leads SET
  pausado_at  = COALESCE(pausado_at, datetime('now')),
  cerrado_at  = COALESCE(cerrado_at, datetime('now')),
  updated_at  = datetime('now')
WHERE numero = '5493417182512';
