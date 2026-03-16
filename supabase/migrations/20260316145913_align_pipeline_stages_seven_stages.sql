/*
  # Align pipeline stages to 7 canonical values

  1. Changes
    - Remap `contactado` -> `en_proceso` in `whatsapp_contacts`
    - Remap `en_negociacion` -> `en_proceso` in `whatsapp_contacts`
    - Add CHECK constraint to enforce only 7 valid stages:
      nuevo, en_proceso, demo_solicitada, cotizacion_enviada, por_cerrar, ganado, perdido

  2. Security
    - No RLS changes (existing policies remain)

  3. Notes
    - This is a data alignment migration to remove legacy stage values
    - The CHECK constraint prevents future invalid stage values
*/

UPDATE whatsapp_contacts
SET lead_stage = 'en_proceso'
WHERE lead_stage = 'contactado';

UPDATE whatsapp_contacts
SET lead_stage = 'en_proceso'
WHERE lead_stage = 'en_negociacion';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'whatsapp_contacts'
    AND constraint_name = 'whatsapp_contacts_lead_stage_check'
  ) THEN
    ALTER TABLE whatsapp_contacts
    ADD CONSTRAINT whatsapp_contacts_lead_stage_check
    CHECK (lead_stage IN ('nuevo', 'en_proceso', 'demo_solicitada', 'cotizacion_enviada', 'por_cerrar', 'ganado', 'perdido'));
  END IF;
END $$;
