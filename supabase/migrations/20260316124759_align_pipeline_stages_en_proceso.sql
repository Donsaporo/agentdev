/*
  # Align pipeline stages: rename en_negociacion to en_proceso

  1. Data Changes
    - `whatsapp_contacts`: All rows with lead_stage 'en_negociacion' updated to 'en_proceso'
    - `whatsapp_contacts`: All rows with lead_stage 'cerrado' updated to 'ganado'
  
  2. Important Notes
    - These updates align the database with the new pipeline stage naming convention
    - No schema changes, only data migration
    - Safe: only updates specific known values
*/

UPDATE whatsapp_contacts SET lead_stage = 'en_proceso' WHERE lead_stage = 'en_negociacion';
UPDATE whatsapp_contacts SET lead_stage = 'ganado' WHERE lead_stage = 'cerrado';
