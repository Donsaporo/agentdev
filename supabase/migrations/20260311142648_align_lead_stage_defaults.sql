/*
  # Align lead_stage column default to official pipeline values

  1. Changes
    - Update `whatsapp_contacts.lead_stage` default from 'new' to 'vacio'
    - Migrate any existing 'new' values to 'vacio'
  
  2. Pipeline Stages
    - vacio: New contact, no interaction yet
    - lead: Qualified contact with active interest
    - cliente_nuevo: Client who paid 50% deposit
    - cliente_terminado: Completed project, delivered
*/

ALTER TABLE whatsapp_contacts ALTER COLUMN lead_stage SET DEFAULT 'vacio';

UPDATE whatsapp_contacts SET lead_stage = 'vacio' WHERE lead_stage = 'new';
