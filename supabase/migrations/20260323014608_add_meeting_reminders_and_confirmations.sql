/*
  # Add meeting reminders and confirmation tracking

  1. Modified Tables
    - `sales_meetings`
      - `reminder_24h_sent` (boolean) - whether the 24h-before reminder was sent
      - `reminder_1h_sent` (boolean) - whether the 1h-before reminder was sent
      - `client_confirmed` (boolean, nullable) - null = pending, true = confirmed, false = declined
      - `confirmed_at` (timestamptz) - when the client confirmed/declined

  2. New Tables
    - `meeting_reminder_queue`
      - `id` (uuid, primary key)
      - `meeting_id` (uuid, FK to sales_meetings)
      - `contact_id` (uuid, FK to whatsapp_contacts)
      - `conversation_id` (uuid, FK to whatsapp_conversations)
      - `reminder_type` (text: '24h' or '1h')
      - `status` (text: 'pending_response', 'sent', 'expired')
      - `meet_link` (text)
      - `meeting_title` (text)
      - `meeting_start_time` (timestamptz)
      - `template_sent_at` (timestamptz)
      - `message_sent_at` (timestamptz)
      - `created_at` (timestamptz)

  3. Security
    - Enable RLS on `meeting_reminder_queue`
    - Policies for authenticated team members (select, insert, update, delete)

  4. Indexes
    - status + meeting_id on meeting_reminder_queue
    - contact_id on meeting_reminder_queue
    - status on sales_meetings (for reminder queries)
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sales_meetings' AND column_name = 'reminder_24h_sent'
  ) THEN
    ALTER TABLE sales_meetings ADD COLUMN reminder_24h_sent boolean DEFAULT false;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sales_meetings' AND column_name = 'reminder_1h_sent'
  ) THEN
    ALTER TABLE sales_meetings ADD COLUMN reminder_1h_sent boolean DEFAULT false;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sales_meetings' AND column_name = 'client_confirmed'
  ) THEN
    ALTER TABLE sales_meetings ADD COLUMN client_confirmed boolean;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sales_meetings' AND column_name = 'confirmed_at'
  ) THEN
    ALTER TABLE sales_meetings ADD COLUMN confirmed_at timestamptz;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS meeting_reminder_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id uuid NOT NULL REFERENCES sales_meetings(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES whatsapp_contacts(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES whatsapp_conversations(id) ON DELETE CASCADE,
  reminder_type text NOT NULL DEFAULT '24h',
  status text NOT NULL DEFAULT 'pending_response',
  meet_link text DEFAULT '',
  meeting_title text DEFAULT '',
  meeting_start_time timestamptz NOT NULL,
  template_sent_at timestamptz,
  message_sent_at timestamptz,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE meeting_reminder_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Team members can view meeting reminders"
  ON meeting_reminder_queue
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM team_members
      WHERE team_members.id = auth.uid()
    )
  );

CREATE POLICY "Team members can insert meeting reminders"
  ON meeting_reminder_queue
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM team_members
      WHERE team_members.id = auth.uid()
    )
  );

CREATE POLICY "Team members can update meeting reminders"
  ON meeting_reminder_queue
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

CREATE POLICY "Team members can delete meeting reminders"
  ON meeting_reminder_queue
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM team_members
      WHERE team_members.id = auth.uid()
    )
  );

CREATE INDEX IF NOT EXISTS idx_meeting_reminder_queue_status ON meeting_reminder_queue(status);
CREATE INDEX IF NOT EXISTS idx_meeting_reminder_queue_contact ON meeting_reminder_queue(contact_id);
CREATE INDEX IF NOT EXISTS idx_meeting_reminder_queue_meeting ON meeting_reminder_queue(meeting_id);
CREATE INDEX IF NOT EXISTS idx_sales_meetings_reminder_status ON sales_meetings(status, reminder_24h_sent, reminder_1h_sent);
