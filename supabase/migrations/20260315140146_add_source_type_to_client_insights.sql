/*
  # Add source_type column to client_insights

  1. Modified Tables
    - `client_insights`
      - Added `source_type` (text, NOT NULL, default 'whatsapp')
        - Tracks where the insight originated: whatsapp, meeting, manual, ai_analysis
      - Added CHECK constraint for valid source_type values
      - Added composite index on (contact_id, source_type) for filtered queries

  2. Important Notes
    - Existing rows default to 'whatsapp' since all current insights come from WhatsApp conversations
    - The meeting source_type enables storing insights extracted from meeting transcripts
    - source_conversation_id remains nullable (meetings don't have a conversation)
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'client_insights' AND column_name = 'source_type'
  ) THEN
    ALTER TABLE client_insights ADD COLUMN source_type text NOT NULL DEFAULT 'whatsapp';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'client_insights_source_type_check'
  ) THEN
    ALTER TABLE client_insights ADD CONSTRAINT client_insights_source_type_check
      CHECK (source_type IN ('whatsapp', 'meeting', 'manual', 'ai_analysis'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_client_insights_contact_source
  ON client_insights (contact_id, source_type);
