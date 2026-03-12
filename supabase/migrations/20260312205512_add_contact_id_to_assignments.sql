/*
  # Add contact_id to sales_agent_assignments

  1. Changes
    - Adds `contact_id` column to `sales_agent_assignments` for contact-level persona persistence
    - When a contact starts a new conversation, they get the same persona they had before
  
  2. Important Notes
    - This enables permanent persona assignment per contact across multiple conversations
    - Existing assignments won't have contact_id set until next interaction
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sales_agent_assignments' AND column_name = 'contact_id'
  ) THEN
    ALTER TABLE sales_agent_assignments ADD COLUMN contact_id uuid REFERENCES whatsapp_contacts(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_assignments_contact_id ON sales_agent_assignments(contact_id);
