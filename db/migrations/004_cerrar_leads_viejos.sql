-- Cierra leads con más de 30 días de silencio que nunca recibieron seguimiento.
-- Estos quedaron en el DB del período anterior (Meta API) sin actividad reciente.
-- Si alguien escribe de vuelta, el agente los vuelve a activar normalmente.

UPDATE leads
SET
  cerrado_at = datetime('now'),
  updated_at = datetime('now')
WHERE
  cerrado_at IS NULL
  AND pausado_at IS NULL
  AND handoff_at IS NULL
  AND ultimo_lead_at IS NOT NULL
  AND ultimo_lead_at < datetime('now', '-30 days');
