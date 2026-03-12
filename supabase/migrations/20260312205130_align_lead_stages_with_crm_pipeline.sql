/*
  # Align lead stages with CRM pipeline

  1. Changes
    - Updates `whatsapp_contacts.lead_stage` to use the CRM's 8 pipeline stages
    - Migrates existing data from old 10-stage system to new 8-stage system
    - Mapping:
      - 'vacio' → 'nuevo'
      - 'interesado' → 'contactado'
      - 'calificado' → 'en_negociacion'
      - 'reunion_agendada' → 'demo_solicitada'
      - 'reunion_completada' → 'demo_solicitada'
      - 'propuesta_enviada' → 'cotizacion_enviada'
      - 'negociacion' → 'por_cerrar'
      - 'cerrado_ganado' → 'ganado'
      - 'cerrado_perdido' → 'perdido'
      - 'inactivo' → 'perdido'
  
  2. New CRM Pipeline Stages (CHECK constraint values)
    - nuevo, contactado, en_negociacion, demo_solicitada, cotizacion_enviada, por_cerrar, ganado, perdido
  
  3. Important Notes
    - This is a data-only migration, no column drops or destructive changes
    - Sets default to 'nuevo' for any unrecognized values
*/

UPDATE whatsapp_contacts SET lead_stage = 'nuevo' WHERE lead_stage = 'vacio';
UPDATE whatsapp_contacts SET lead_stage = 'contactado' WHERE lead_stage = 'interesado';
UPDATE whatsapp_contacts SET lead_stage = 'en_negociacion' WHERE lead_stage = 'calificado';
UPDATE whatsapp_contacts SET lead_stage = 'demo_solicitada' WHERE lead_stage IN ('reunion_agendada', 'reunion_completada');
UPDATE whatsapp_contacts SET lead_stage = 'cotizacion_enviada' WHERE lead_stage = 'propuesta_enviada';
UPDATE whatsapp_contacts SET lead_stage = 'por_cerrar' WHERE lead_stage = 'negociacion';
UPDATE whatsapp_contacts SET lead_stage = 'ganado' WHERE lead_stage = 'cerrado_ganado';
UPDATE whatsapp_contacts SET lead_stage = 'perdido' WHERE lead_stage IN ('cerrado_perdido', 'inactivo');

UPDATE whatsapp_contacts SET lead_stage = 'nuevo'
WHERE lead_stage NOT IN ('nuevo', 'contactado', 'en_negociacion', 'demo_solicitada', 'cotizacion_enviada', 'por_cerrar', 'ganado', 'perdido');

ALTER TABLE whatsapp_contacts ALTER COLUMN lead_stage SET DEFAULT 'nuevo';
