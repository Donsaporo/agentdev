/*
  # Prevent Duplicate Active Conversations

  1. Changes
    - Add unique partial index on `whatsapp_conversations` for `(contact_id)` where `status = 'active'`
    - This ensures only ONE active conversation can exist per contact at the database level
    - Prevents race conditions in the webhook from creating duplicate conversations

  2. Pre-cleanup
    - Before creating the index, archive any existing duplicate active conversations
    - Keep the most recent conversation (by last_message_at) as the active one
    - Reassign messages from archived duplicates to the surviving conversation

  3. Important Notes
    - This is a data-safety operation: no data is deleted, duplicates are archived
    - The unique index will reject future duplicate inserts with a constraint error
    - The webhook code has been updated to handle this gracefully
*/

DO $$
DECLARE
  dup RECORD;
  survivor_id uuid;
BEGIN
  FOR dup IN
    SELECT contact_id, COUNT(*) as cnt
    FROM whatsapp_conversations
    WHERE status = 'active'
    GROUP BY contact_id
    HAVING COUNT(*) > 1
  LOOP
    SELECT id INTO survivor_id
    FROM whatsapp_conversations
    WHERE contact_id = dup.contact_id AND status = 'active'
    ORDER BY last_message_at DESC NULLS LAST
    LIMIT 1;

    UPDATE whatsapp_messages
    SET conversation_id = survivor_id
    WHERE conversation_id IN (
      SELECT id FROM whatsapp_conversations
      WHERE contact_id = dup.contact_id
        AND status = 'active'
        AND id != survivor_id
    );

    UPDATE whatsapp_conversations
    SET status = 'archived'
    WHERE contact_id = dup.contact_id
      AND status = 'active'
      AND id != survivor_id;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_active_conversation_per_contact
  ON whatsapp_conversations (contact_id)
  WHERE status = 'active';
