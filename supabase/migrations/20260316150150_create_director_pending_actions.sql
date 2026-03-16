/*
  # Create director_pending_actions table

  1. New Tables
    - `director_pending_actions`
      - `id` (uuid, primary key, auto-generated)
      - `director_phone` (text, not null) - phone of the director who initiated
      - `action_type` (text, not null) - send_message, schedule_meeting, update_stage, pause_ai, resume_ai, request_info
      - `target_contact_id` (uuid, nullable) - the contact this action targets
      - `target_conversation_id` (uuid, nullable) - the conversation this action targets
      - `action_payload` (jsonb, not null, default '{}') - full action details (message text, meeting params, etc.)
      - `confirmation_message` (text, not null, default '') - what was shown to director for confirmation
      - `status` (text, not null, default 'pending_confirmation') - pending_confirmation, confirmed, cancelled, expired
      - `created_at` (timestamptz, default now())
      - `resolved_at` (timestamptz, nullable)

  2. Security
    - Enable RLS on `director_pending_actions`
    - Service role only policies (SELECT, INSERT, UPDATE, DELETE)

  3. Indexes
    - Index on `director_phone` + `status` for quick pending lookup

  4. Notes
    - Used by the director conversational agent to track actions awaiting confirmation
    - Only the most recent pending action per director is active; older ones auto-expire
*/

CREATE TABLE IF NOT EXISTS director_pending_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  director_phone text NOT NULL,
  action_type text NOT NULL,
  target_contact_id uuid REFERENCES whatsapp_contacts(id) ON DELETE SET NULL,
  target_conversation_id uuid REFERENCES whatsapp_conversations(id) ON DELETE SET NULL,
  action_payload jsonb NOT NULL DEFAULT '{}',
  confirmation_message text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending_confirmation',
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

ALTER TABLE director_pending_actions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role can select director actions"
  ON director_pending_actions
  FOR SELECT
  TO service_role
  USING (true);

CREATE POLICY "Service role can insert director actions"
  ON director_pending_actions
  FOR INSERT
  TO service_role
  WITH CHECK (true);

CREATE POLICY "Service role can update director actions"
  ON director_pending_actions
  FOR UPDATE
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Service role can delete director actions"
  ON director_pending_actions
  FOR DELETE
  TO service_role
  USING (true);

CREATE INDEX IF NOT EXISTS idx_director_pending_actions_phone_status
  ON director_pending_actions (director_phone, status)
  WHERE status = 'pending_confirmation';
