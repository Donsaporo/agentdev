/*
  # Add Conversation Summaries and Structured Client Insights

  1. New Tables
    - `conversation_summaries`
      - `id` (uuid, primary key)
      - `conversation_id` (uuid, FK to whatsapp_conversations)
      - `contact_id` (uuid, FK to whatsapp_contacts)
      - `summary` (text) - AI-generated summary of conversation chunk
      - `message_range_start` (timestamptz) - first message timestamp covered
      - `message_range_end` (timestamptz) - last message timestamp covered
      - `message_count` (integer) - number of messages summarized
      - `key_topics` (text[]) - main topics discussed
      - `created_at` (timestamptz)
    - `client_insights`
      - `id` (uuid, primary key)
      - `contact_id` (uuid, FK to whatsapp_contacts)
      - `category` (text) - structured insight category
      - `content` (text) - the actual insight
      - `source_conversation_id` (uuid, FK to whatsapp_conversations, nullable)
      - `confidence` (text) - high, medium, low
      - `is_active` (boolean) - whether this insight is still relevant
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)

  2. Security
    - Enable RLS on both tables
    - Restrict access to authenticated team members

  3. Indexes
    - conversation_summaries: by conversation_id, by contact_id
    - client_insights: by contact_id + is_active, by category
*/

CREATE TABLE IF NOT EXISTS conversation_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES whatsapp_conversations(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES whatsapp_contacts(id) ON DELETE CASCADE,
  summary text NOT NULL,
  message_range_start timestamptz NOT NULL,
  message_range_end timestamptz NOT NULL,
  message_count integer NOT NULL DEFAULT 0,
  key_topics text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE conversation_summaries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Team members can view conversation_summaries"
  ON conversation_summaries
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM team_members
      WHERE team_members.id = auth.uid()
    )
  );

CREATE POLICY "Team members can insert conversation_summaries"
  ON conversation_summaries
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM team_members
      WHERE team_members.id = auth.uid()
    )
  );

CREATE TABLE IF NOT EXISTS client_insights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES whatsapp_contacts(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN (
    'need', 'objection', 'preference', 'budget', 'timeline',
    'decision_maker', 'competitor', 'pain_point', 'positive_signal', 'personal_detail'
  )),
  content text NOT NULL,
  source_conversation_id uuid REFERENCES whatsapp_conversations(id) ON DELETE SET NULL,
  confidence text NOT NULL DEFAULT 'medium' CHECK (confidence IN ('high', 'medium', 'low')),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE client_insights ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Team members can view client_insights"
  ON client_insights
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM team_members
      WHERE team_members.id = auth.uid()
    )
  );

CREATE POLICY "Team members can insert client_insights"
  ON client_insights
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM team_members
      WHERE team_members.id = auth.uid()
    )
  );

CREATE POLICY "Team members can update client_insights"
  ON client_insights
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM team_members
      WHERE team_members.id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM team_members
      WHERE team_members.id = auth.uid()
    )
  );

CREATE INDEX IF NOT EXISTS idx_conversation_summaries_conversation
  ON conversation_summaries(conversation_id);

CREATE INDEX IF NOT EXISTS idx_conversation_summaries_contact
  ON conversation_summaries(contact_id);

CREATE INDEX IF NOT EXISTS idx_client_insights_contact_active
  ON client_insights(contact_id, is_active)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_client_insights_category
  ON client_insights(contact_id, category);
