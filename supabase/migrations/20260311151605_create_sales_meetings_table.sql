/*
  # Create sales meetings table

  1. New Tables
    - `sales_meetings`
      - `id` (uuid, primary key)
      - `conversation_id` (uuid, FK to whatsapp_conversations)
      - `contact_id` (uuid, FK to whatsapp_contacts)
      - `google_event_id` (text, unique Google Calendar event ID)
      - `title` (text, meeting title)
      - `start_time` (timestamptz, scheduled start)
      - `end_time` (timestamptz, scheduled end)
      - `meet_link` (text, Google Meet URL)
      - `recall_bot_id` (text, Recall.ai bot ID for transcription)
      - `transcript` (text, meeting transcript from Recall)
      - `summary` (text, AI-generated meeting summary)
      - `status` (text, scheduled/in_progress/completed/cancelled)
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)

  2. Security
    - Enable RLS on `sales_meetings` table
    - Policies for authenticated team members
    - Service role full access for the sales agent backend

  3. Indexes
    - conversation_id, contact_id, google_event_id, recall_bot_id, status
*/

CREATE TABLE IF NOT EXISTS sales_meetings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES whatsapp_conversations(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES whatsapp_contacts(id) ON DELETE CASCADE,
  google_event_id text UNIQUE,
  title text NOT NULL DEFAULT '',
  start_time timestamptz NOT NULL,
  end_time timestamptz NOT NULL,
  meet_link text DEFAULT '',
  recall_bot_id text,
  transcript text,
  summary text,
  status text NOT NULL DEFAULT 'scheduled',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE sales_meetings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Team members can view meetings"
  ON sales_meetings
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM team_members
      WHERE team_members.id = auth.uid()
    )
  );

CREATE POLICY "Team members can insert meetings"
  ON sales_meetings
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM team_members
      WHERE team_members.id = auth.uid()
    )
  );

CREATE POLICY "Team members can update meetings"
  ON sales_meetings
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

CREATE INDEX IF NOT EXISTS idx_sales_meetings_conversation ON sales_meetings(conversation_id);
CREATE INDEX IF NOT EXISTS idx_sales_meetings_contact ON sales_meetings(contact_id);
CREATE INDEX IF NOT EXISTS idx_sales_meetings_google_event ON sales_meetings(google_event_id);
CREATE INDEX IF NOT EXISTS idx_sales_meetings_recall_bot ON sales_meetings(recall_bot_id);
CREATE INDEX IF NOT EXISTS idx_sales_meetings_status ON sales_meetings(status);
