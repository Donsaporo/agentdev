/*
  # Fix media_download_status default value

  1. Schema Changes
    - `whatsapp_messages`: Change default of `media_download_status` from 'pending' to 'none'

  2. Data Changes
    - Update existing outbound messages that incorrectly have 'pending' status to 'none'

  3. Important Notes
    - Outbound messages never need media downloading, so their status should be 'none'
    - New messages without explicit media_download_status will now default to 'none'
    - Only inbound media messages should have 'pending' status (set explicitly on insert)
*/

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'whatsapp_messages' AND column_name = 'media_download_status'
  ) THEN
    ALTER TABLE whatsapp_messages ALTER COLUMN media_download_status SET DEFAULT 'none';
  END IF;
END $$;

UPDATE whatsapp_messages
SET media_download_status = 'none'
WHERE direction = 'outbound' AND media_download_status = 'pending';
