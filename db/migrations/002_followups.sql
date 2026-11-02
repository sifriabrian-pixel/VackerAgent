-- Seguimientos automáticos: timestamps de cuándo se envió cada seguimiento.
-- NULL = todavía no enviado.
ALTER TABLE leads ADD COLUMN followup_24h_at TEXT;
ALTER TABLE leads ADD COLUMN followup_48h_at TEXT;
