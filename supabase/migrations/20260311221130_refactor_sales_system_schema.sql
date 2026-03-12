/*
  # Refactor Sales System Schema

  Major schema cleanup and additions for the sales agent system.

  1. New Tables
    - `client_profiles` - Unified client profile that can link multiple WhatsApp contacts (multi-phone support)
      - `id` (uuid, primary key)
      - `display_name` (text) - Client's preferred name
      - `email` (text) - Primary email
      - `company` (text) - Company name
      - `industry` (text) - Industry sector
      - `estimated_budget` (text) - Budget range
      - `source` (text) - How they found us
      - `notes` (text) - General notes
      - `crm_client_id` (uuid) - Link to external CRM
      - `created_at`, `updated_at` (timestamptz)

  2. Modified Tables
    - `whatsapp_contacts` - Added `client_profile_id` FK to `client_profiles` for multi-phone grouping
    - `whatsapp_conversations` - Added director review tracking fields:
      - `director_reviewed_at` - When the director last reviewed this conversation
      - `director_notes` - Director's private annotations
      - `needs_director_attention` - Flag for conversations needing review
      - `priority_score` - Computed priority for sorting
    - `whatsapp_contacts.lead_stage` default updated to 'nuevo'

  3. Security
    - RLS enabled on `client_profiles`
    - Policies for authenticated team members (CRUD)

  4. Notes
    - `lead_stage` now supports: nuevo, interesado, calificado, reunion_agendada,
      reunion_completada, propuesta_enviada, negociacion, cerrado_ganado, cerrado_perdido, inactivo
    - Client profiles allow grouping multiple phone numbers under one client
*/

CREATE TABLE IF NOT EXISTS client_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL DEFAULT '',
  email text DEFAULT '',
  company text DEFAULT '',
  industry text DEFAULT '',
  estimated_budget text DEFAULT '',
  source text DEFAULT '',
  notes text DEFAULT '',
  crm_client_id uuid DEFAULT null,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE client_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Team members can view client profiles"
  ON client_profiles FOR SELECT
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM team_members WHERE team_members.id = auth.uid())
  );

CREATE POLICY "Team members can insert client profiles"
  ON client_profiles FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM team_members WHERE team_members.id = auth.uid())
  );

CREATE POLICY "Team members can update client profiles"
  ON client_profiles FOR UPDATE
  TO authenticated
  USING (EXISTS (SELECT 1 FROM team_members WHERE team_members.id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM team_members WHERE team_members.id = auth.uid()));

CREATE POLICY "Team members can delete client profiles"
  ON client_profiles FOR DELETE
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM team_members WHERE team_members.id = auth.uid())
  );

CREATE POLICY "Service role full access to client profiles"
  ON client_profiles FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'whatsapp_contacts' AND column_name = 'client_profile_id'
  ) THEN
    ALTER TABLE whatsapp_contacts ADD COLUMN client_profile_id uuid REFERENCES client_profiles(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'whatsapp_conversations' AND column_name = 'director_reviewed_at'
  ) THEN
    ALTER TABLE whatsapp_conversations ADD COLUMN director_reviewed_at timestamptz DEFAULT null;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'whatsapp_conversations' AND column_name = 'director_notes'
  ) THEN
    ALTER TABLE whatsapp_conversations ADD COLUMN director_notes text DEFAULT '';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'whatsapp_conversations' AND column_name = 'needs_director_attention'
  ) THEN
    ALTER TABLE whatsapp_conversations ADD COLUMN needs_director_attention boolean DEFAULT false;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'whatsapp_conversations' AND column_name = 'priority_score'
  ) THEN
    ALTER TABLE whatsapp_conversations ADD COLUMN priority_score integer DEFAULT 0;
  END IF;
END $$;

ALTER TABLE whatsapp_contacts ALTER COLUMN lead_stage SET DEFAULT 'nuevo';

CREATE INDEX IF NOT EXISTS idx_contacts_client_profile ON whatsapp_contacts(client_profile_id);
CREATE INDEX IF NOT EXISTS idx_conversations_director_review ON whatsapp_conversations(director_reviewed_at);
CREATE INDEX IF NOT EXISTS idx_conversations_needs_attention ON whatsapp_conversations(needs_director_attention) WHERE needs_director_attention = true;
CREATE INDEX IF NOT EXISTS idx_conversations_priority ON whatsapp_conversations(priority_score DESC);
CREATE INDEX IF NOT EXISTS idx_client_profiles_crm ON client_profiles(crm_client_id);

ALTER PUBLICATION supabase_realtime ADD TABLE client_profiles;
