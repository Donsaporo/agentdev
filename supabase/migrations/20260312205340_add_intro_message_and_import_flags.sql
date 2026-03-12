/*
  # Add intro message and import tracking flags

  1. New Columns
    - `whatsapp_contacts.is_imported` (boolean, default false) - tracks if contact was bulk imported
    - `whatsapp_contacts.intro_sent` (boolean, default false) - tracks if intro message was already sent
    - `whatsapp_contacts.follow_up_count` (integer, default 0) - tracks follow-up messages sent
  
  2. Important Notes
    - `is_imported` contacts skip the intro message when they first write
    - `intro_sent` prevents sending the intro message more than once
    - `follow_up_count` used to limit auto follow-ups to max 2 per contact
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'whatsapp_contacts' AND column_name = 'is_imported'
  ) THEN
    ALTER TABLE whatsapp_contacts ADD COLUMN is_imported boolean DEFAULT false;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'whatsapp_contacts' AND column_name = 'intro_sent'
  ) THEN
    ALTER TABLE whatsapp_contacts ADD COLUMN intro_sent boolean DEFAULT false;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'whatsapp_contacts' AND column_name = 'follow_up_count'
  ) THEN
    ALTER TABLE whatsapp_contacts ADD COLUMN follow_up_count integer DEFAULT 0;
  END IF;
END $$;

UPDATE whatsapp_contacts SET intro_sent = true WHERE is_imported = true;
