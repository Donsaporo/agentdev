/*
  # Solidify Sales Agent Foundations

  This migration applies critical fixes to ensure data integrity and enable
  per-persona instruction filtering and salesperson assignment.

  1. Data Cleanup
    - Remove duplicate `whatsapp_messages` rows (keep earliest per wa_message_id)

  2. Modified Tables
    - `whatsapp_messages` - Add UNIQUE partial index on `wa_message_id` to prevent
      duplicate messages from webhook retries
    - `sales_agent_instructions` - Add `persona_id` column (nullable) to allow
      instructions that apply only to a specific persona (null = global)
    - `sales_agent_personas` - Add `team_member_id` column to link each persona
      to the real salesperson behind it

  3. Indexes
    - Unique partial index on `wa_message_id` (where not empty)
    - Index on `sales_agent_instructions.persona_id`
    - Index on `sales_agent_personas.team_member_id`

  4. Notes
    - The UNIQUE constraint uses a partial index (WHERE wa_message_id != '')
      to allow multiple empty strings for system-generated messages
    - Persona-specific instructions allow the director to give different guidance
      to different agent identities
    - team_member_id links a persona to the real person responsible for meetings
*/

DELETE FROM whatsapp_messages
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY wa_message_id
      ORDER BY created_at ASC
    ) AS rn
    FROM whatsapp_messages
    WHERE wa_message_id IS NOT NULL AND wa_message_id != ''
  ) sub
  WHERE rn > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_wa_message_id_unique
  ON whatsapp_messages (wa_message_id)
  WHERE wa_message_id IS NOT NULL AND wa_message_id != '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sales_agent_instructions' AND column_name = 'persona_id'
  ) THEN
    ALTER TABLE sales_agent_instructions
      ADD COLUMN persona_id uuid REFERENCES sales_agent_personas(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_instructions_persona
  ON sales_agent_instructions(persona_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sales_agent_personas' AND column_name = 'team_member_id'
  ) THEN
    ALTER TABLE sales_agent_personas
      ADD COLUMN team_member_id uuid;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_personas_team_member
  ON sales_agent_personas(team_member_id)
  WHERE team_member_id IS NOT NULL;
