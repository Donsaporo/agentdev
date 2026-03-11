/*
  # Sales Agent System - Complete Schema

  This migration creates all tables needed for the autonomous sales agent system.
  The system manages AI agent personas that handle WhatsApp conversations,
  a knowledge base for RAG, director feedback loop, escalation queue,
  meeting transcripts, and full action audit logging.

  1. New Tables
    - `sales_agent_personas` - The 5 AI agent identities (name, style, greeting, signature)
    - `sales_agent_assignments` - Links a persona to a conversation with mode (ai/manual/supervised)
    - `sales_agent_knowledge` - Knowledge base chunks (vector embedding added later when pgvector enabled)
    - `sales_agent_feedback` - Director corrections on specific messages
    - `sales_agent_instructions` - Active compiled rules derived from feedback
    - `sales_agent_actions_log` - Full audit trail of every agent action
    - `sales_meeting_transcripts` - Meeting transcriptions with AI-generated summaries
    - `sales_escalation_queue` - Conversations escalated to humans

  2. Modified Tables
    - `whatsapp_conversations` - Added agent_mode, agent_persona_id, category, last_message_preview, is_agent_typing
    - `whatsapp_contacts` - Added crm_client_id, assigned_team_member, email, company, notes, lead_stage
    - `whatsapp_messages` - Added sender_name

  3. Security
    - RLS enabled on all new tables
    - Policies for authenticated users to manage their data

  4. Indexes
    - Performance indexes on all frequently queried columns

  5. Seed Data
    - 5 initial agent personas: Tatiana, Julieta, Hugo, Maria Fernanda, Danna

  6. Realtime
    - whatsapp_messages, whatsapp_conversations, sales_escalation_queue, sales_agent_feedback added to realtime
*/

-- ============================================================
-- ENUM TYPES
-- ============================================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agent_mode') THEN
    CREATE TYPE agent_mode AS ENUM ('ai', 'manual', 'supervised');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'conversation_category') THEN
    CREATE TYPE conversation_category AS ENUM ('new_lead', 'active_client', 'support', 'escalated', 'archived');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'feedback_type') THEN
    CREATE TYPE feedback_type AS ENUM ('correction', 'instruction', 'new_knowledge', 'praise');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'feedback_status') THEN
    CREATE TYPE feedback_status AS ENUM ('pending', 'processed', 'incorporated');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'instruction_priority') THEN
    CREATE TYPE instruction_priority AS ENUM ('critical', 'high', 'normal');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'escalation_status') THEN
    CREATE TYPE escalation_status AS ENUM ('open', 'attended', 'resolved');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'transcript_status') THEN
    CREATE TYPE transcript_status AS ENUM ('pending', 'processing', 'completed', 'failed');
  END IF;
END $$;

-- ============================================================
-- TABLE: sales_agent_personas
-- ============================================================

CREATE TABLE IF NOT EXISTS sales_agent_personas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name text NOT NULL,
  last_name text NOT NULL,
  full_name text GENERATED ALWAYS AS (first_name || ' ' || last_name) STORED,
  job_title text NOT NULL DEFAULT 'Asesora Comercial',
  communication_style text NOT NULL DEFAULT '',
  greeting_template text NOT NULL DEFAULT '',
  farewell_template text NOT NULL DEFAULT '',
  signature text NOT NULL DEFAULT '',
  avatar_url text NOT NULL DEFAULT '',
  personality_traits jsonb NOT NULL DEFAULT '[]'::jsonb,
  response_length_preference text NOT NULL DEFAULT 'medium',
  emoji_usage text NOT NULL DEFAULT 'minimal',
  formality_level text NOT NULL DEFAULT 'professional_friendly',
  is_active boolean NOT NULL DEFAULT true,
  total_conversations integer NOT NULL DEFAULT 0,
  total_messages_sent integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE sales_agent_personas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view personas"
  ON sales_agent_personas FOR SELECT
  TO authenticated
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can insert personas"
  ON sales_agent_personas FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can update personas"
  ON sales_agent_personas FOR UPDATE
  TO authenticated
  USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can delete personas"
  ON sales_agent_personas FOR DELETE
  TO authenticated
  USING (auth.uid() IS NOT NULL);

-- ============================================================
-- ADD COLUMNS TO whatsapp_conversations
-- ============================================================

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'whatsapp_conversations' AND column_name = 'agent_mode'
  ) THEN
    ALTER TABLE whatsapp_conversations ADD COLUMN agent_mode agent_mode NOT NULL DEFAULT 'ai';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'whatsapp_conversations' AND column_name = 'agent_persona_id'
  ) THEN
    ALTER TABLE whatsapp_conversations ADD COLUMN agent_persona_id uuid REFERENCES sales_agent_personas(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'whatsapp_conversations' AND column_name = 'category'
  ) THEN
    ALTER TABLE whatsapp_conversations ADD COLUMN category conversation_category NOT NULL DEFAULT 'new_lead';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'whatsapp_conversations' AND column_name = 'last_message_preview'
  ) THEN
    ALTER TABLE whatsapp_conversations ADD COLUMN last_message_preview text NOT NULL DEFAULT '';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'whatsapp_conversations' AND column_name = 'is_agent_typing'
  ) THEN
    ALTER TABLE whatsapp_conversations ADD COLUMN is_agent_typing boolean NOT NULL DEFAULT false;
  END IF;
END $$;

-- ============================================================
-- ADD COLUMNS TO whatsapp_contacts
-- ============================================================

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'whatsapp_contacts' AND column_name = 'crm_client_id'
  ) THEN
    ALTER TABLE whatsapp_contacts ADD COLUMN crm_client_id uuid;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'whatsapp_contacts' AND column_name = 'assigned_team_member'
  ) THEN
    ALTER TABLE whatsapp_contacts ADD COLUMN assigned_team_member uuid;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'whatsapp_contacts' AND column_name = 'email'
  ) THEN
    ALTER TABLE whatsapp_contacts ADD COLUMN email text NOT NULL DEFAULT '';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'whatsapp_contacts' AND column_name = 'company'
  ) THEN
    ALTER TABLE whatsapp_contacts ADD COLUMN company text NOT NULL DEFAULT '';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'whatsapp_contacts' AND column_name = 'notes'
  ) THEN
    ALTER TABLE whatsapp_contacts ADD COLUMN notes text NOT NULL DEFAULT '';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'whatsapp_contacts' AND column_name = 'lead_stage'
  ) THEN
    ALTER TABLE whatsapp_contacts ADD COLUMN lead_stage text NOT NULL DEFAULT 'new';
  END IF;
END $$;

-- ============================================================
-- ADD sender_name TO whatsapp_messages
-- ============================================================

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'whatsapp_messages' AND column_name = 'sender_name'
  ) THEN
    ALTER TABLE whatsapp_messages ADD COLUMN sender_name text NOT NULL DEFAULT '';
  END IF;
END $$;

-- ============================================================
-- TABLE: sales_agent_assignments
-- ============================================================

CREATE TABLE IF NOT EXISTS sales_agent_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES whatsapp_conversations(id) ON DELETE CASCADE,
  persona_id uuid NOT NULL REFERENCES sales_agent_personas(id) ON DELETE CASCADE,
  mode agent_mode NOT NULL DEFAULT 'ai',
  taken_over_by uuid,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  mode_changed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(conversation_id)
);

ALTER TABLE sales_agent_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view assignments"
  ON sales_agent_assignments FOR SELECT
  TO authenticated
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can insert assignments"
  ON sales_agent_assignments FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can update assignments"
  ON sales_agent_assignments FOR UPDATE
  TO authenticated
  USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can delete assignments"
  ON sales_agent_assignments FOR DELETE
  TO authenticated
  USING (auth.uid() IS NOT NULL);

-- ============================================================
-- TABLE: sales_agent_knowledge
-- ============================================================

CREATE TABLE IF NOT EXISTS sales_agent_knowledge (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category text NOT NULL DEFAULT 'general',
  title text NOT NULL,
  content text NOT NULL,
  source text NOT NULL DEFAULT 'system',
  is_active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE sales_agent_knowledge ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view knowledge"
  ON sales_agent_knowledge FOR SELECT
  TO authenticated
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can insert knowledge"
  ON sales_agent_knowledge FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can update knowledge"
  ON sales_agent_knowledge FOR UPDATE
  TO authenticated
  USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can delete knowledge"
  ON sales_agent_knowledge FOR DELETE
  TO authenticated
  USING (auth.uid() IS NOT NULL);

-- ============================================================
-- TABLE: sales_agent_feedback
-- ============================================================

CREATE TABLE IF NOT EXISTS sales_agent_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES whatsapp_conversations(id) ON DELETE SET NULL,
  message_id uuid REFERENCES whatsapp_messages(id) ON DELETE SET NULL,
  feedback_type feedback_type NOT NULL DEFAULT 'correction',
  content text NOT NULL,
  status feedback_status NOT NULL DEFAULT 'pending',
  created_by uuid NOT NULL,
  processed_at timestamptz,
  resulting_instruction_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE sales_agent_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view feedback"
  ON sales_agent_feedback FOR SELECT
  TO authenticated
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can insert feedback"
  ON sales_agent_feedback FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = created_by);

CREATE POLICY "Authenticated users can update feedback"
  ON sales_agent_feedback FOR UPDATE
  TO authenticated
  USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can delete feedback"
  ON sales_agent_feedback FOR DELETE
  TO authenticated
  USING (auth.uid() = created_by);

-- ============================================================
-- TABLE: sales_agent_instructions
-- ============================================================

CREATE TABLE IF NOT EXISTS sales_agent_instructions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instruction text NOT NULL,
  priority instruction_priority NOT NULL DEFAULT 'normal',
  category text NOT NULL DEFAULT 'general',
  is_active boolean NOT NULL DEFAULT true,
  source_feedback_id uuid REFERENCES sales_agent_feedback(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE sales_agent_instructions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view instructions"
  ON sales_agent_instructions FOR SELECT
  TO authenticated
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can insert instructions"
  ON sales_agent_instructions FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can update instructions"
  ON sales_agent_instructions FOR UPDATE
  TO authenticated
  USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can delete instructions"
  ON sales_agent_instructions FOR DELETE
  TO authenticated
  USING (auth.uid() IS NOT NULL);

-- ============================================================
-- TABLE: sales_agent_actions_log
-- ============================================================

CREATE TABLE IF NOT EXISTS sales_agent_actions_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type text NOT NULL,
  conversation_id uuid REFERENCES whatsapp_conversations(id) ON DELETE SET NULL,
  contact_id uuid REFERENCES whatsapp_contacts(id) ON DELETE SET NULL,
  persona_id uuid REFERENCES sales_agent_personas(id) ON DELETE SET NULL,
  input_summary text NOT NULL DEFAULT '',
  output_summary text NOT NULL DEFAULT '',
  model_used text NOT NULL DEFAULT '',
  tokens_input integer NOT NULL DEFAULT 0,
  tokens_output integer NOT NULL DEFAULT 0,
  duration_ms integer NOT NULL DEFAULT 0,
  success boolean NOT NULL DEFAULT true,
  error_message text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE sales_agent_actions_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view actions log"
  ON sales_agent_actions_log FOR SELECT
  TO authenticated
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can insert actions log"
  ON sales_agent_actions_log FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

-- ============================================================
-- TABLE: sales_meeting_transcripts
-- ============================================================

CREATE TABLE IF NOT EXISTS sales_meeting_transcripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES whatsapp_conversations(id) ON DELETE SET NULL,
  contact_id uuid REFERENCES whatsapp_contacts(id) ON DELETE SET NULL,
  meeting_url text NOT NULL DEFAULT '',
  recall_bot_id text NOT NULL DEFAULT '',
  raw_transcript text NOT NULL DEFAULT '',
  summary text NOT NULL DEFAULT '',
  action_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  client_commitments jsonb NOT NULL DEFAULT '[]'::jsonb,
  next_steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  status transcript_status NOT NULL DEFAULT 'pending',
  meeting_date timestamptz,
  duration_minutes integer NOT NULL DEFAULT 0,
  participants jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE sales_meeting_transcripts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view transcripts"
  ON sales_meeting_transcripts FOR SELECT
  TO authenticated
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can insert transcripts"
  ON sales_meeting_transcripts FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can update transcripts"
  ON sales_meeting_transcripts FOR UPDATE
  TO authenticated
  USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);

-- ============================================================
-- TABLE: sales_escalation_queue
-- ============================================================

CREATE TABLE IF NOT EXISTS sales_escalation_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES whatsapp_conversations(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES whatsapp_contacts(id) ON DELETE SET NULL,
  reason text NOT NULL,
  priority instruction_priority NOT NULL DEFAULT 'normal',
  status escalation_status NOT NULL DEFAULT 'open',
  assigned_to uuid,
  resolved_at timestamptz,
  resolution_notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE sales_escalation_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view escalations"
  ON sales_escalation_queue FOR SELECT
  TO authenticated
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can insert escalations"
  ON sales_escalation_queue FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can update escalations"
  ON sales_escalation_queue FOR UPDATE
  TO authenticated
  USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_agent_assignments_conversation ON sales_agent_assignments(conversation_id);
CREATE INDEX IF NOT EXISTS idx_agent_assignments_persona ON sales_agent_assignments(persona_id);
CREATE INDEX IF NOT EXISTS idx_agent_knowledge_category ON sales_agent_knowledge(category) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_agent_feedback_conversation ON sales_agent_feedback(conversation_id);
CREATE INDEX IF NOT EXISTS idx_agent_feedback_status ON sales_agent_feedback(status);
CREATE INDEX IF NOT EXISTS idx_agent_instructions_active ON sales_agent_instructions(is_active, priority);
CREATE INDEX IF NOT EXISTS idx_agent_actions_conversation ON sales_agent_actions_log(conversation_id);
CREATE INDEX IF NOT EXISTS idx_agent_actions_type ON sales_agent_actions_log(action_type);
CREATE INDEX IF NOT EXISTS idx_agent_actions_created ON sales_agent_actions_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_meeting_transcripts_contact ON sales_meeting_transcripts(contact_id);
CREATE INDEX IF NOT EXISTS idx_meeting_transcripts_status ON sales_meeting_transcripts(status);
CREATE INDEX IF NOT EXISTS idx_escalation_status ON sales_escalation_queue(status);
CREATE INDEX IF NOT EXISTS idx_escalation_conversation ON sales_escalation_queue(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversations_category ON whatsapp_conversations(category);
CREATE INDEX IF NOT EXISTS idx_conversations_agent_mode ON whatsapp_conversations(agent_mode);
CREATE INDEX IF NOT EXISTS idx_contacts_lead_stage ON whatsapp_contacts(lead_stage);
CREATE INDEX IF NOT EXISTS idx_contacts_crm_client ON whatsapp_contacts(crm_client_id) WHERE crm_client_id IS NOT NULL;

-- ============================================================
-- SEED: Initial Agent Personas
-- ============================================================

INSERT INTO sales_agent_personas (first_name, last_name, job_title, communication_style, greeting_template, farewell_template, signature, personality_traits, formality_level, emoji_usage, response_length_preference)
VALUES
  ('Tatiana', 'Velázquez', 'Asesora Comercial Senior', '', '', '', 'Tatiana Velázquez - Obzide Tech', '["profesional", "cálida", "directa", "orientada a resultados"]'::jsonb, 'professional_friendly', 'minimal', 'medium'),
  ('Julieta', 'Casanova', 'Asesora de Desarrollo', '', '', '', 'Julieta Casanova - Obzide Tech', '["entusiasta", "detallista", "empática", "técnica"]'::jsonb, 'professional_friendly', 'moderate', 'medium'),
  ('Hugo', 'Sánchez', 'Asesor Comercial', '', '', '', 'Hugo Sánchez - Obzide Tech', '["confiable", "conciso", "resolutivo", "amigable"]'::jsonb, 'professional_friendly', 'minimal', 'short'),
  ('María Fernanda', 'Rodríguez', 'Asesora de Proyectos', '', '', '', 'María Fernanda Rodríguez - Obzide Tech', '["organizada", "paciente", "analítica", "servicial"]'::jsonb, 'professional_friendly', 'moderate', 'long'),
  ('Danna', 'Almirante', 'Asesora de Cuentas', '', '', '', 'Danna Almirante - Obzide Tech', '["creativa", "persuasiva", "dinámica", "cercana"]'::jsonb, 'professional_friendly', 'moderate', 'medium')
ON CONFLICT DO NOTHING;

-- ============================================================
-- ENABLE REALTIME for key tables
-- ============================================================

DO $$ BEGIN
  EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE whatsapp_messages';
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE whatsapp_conversations';
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE sales_escalation_queue';
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE sales_agent_feedback';
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Set REPLICA IDENTITY FULL for realtime to work properly
ALTER TABLE whatsapp_messages REPLICA IDENTITY FULL;
ALTER TABLE whatsapp_conversations REPLICA IDENTITY FULL;
ALTER TABLE sales_escalation_queue REPLICA IDENTITY FULL;
ALTER TABLE sales_agent_feedback REPLICA IDENTITY FULL;
