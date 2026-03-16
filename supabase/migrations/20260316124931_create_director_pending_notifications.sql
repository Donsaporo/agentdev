/*
  # Create director_pending_notifications table

  1. New Tables
    - `director_pending_notifications`
      - `id` (uuid, primary key, auto-generated)
      - `director_phone` (text, not null) - phone number of the director to notify
      - `notification_type` (text, not null) - type of notification (escalation, meeting_scheduled, lead_won, etc.)
      - `payload` (jsonb, not null, default '{}') - notification details
      - `status` (text, not null, default 'pending') - pending, sent, failed
      - `created_at` (timestamptz, default now())
      - `sent_at` (timestamptz, nullable) - when the notification was actually sent

  2. Security
    - Enable RLS on `director_pending_notifications`
    - Policies for service_role access only (SELECT, INSERT, UPDATE, DELETE)

  3. Indexes
    - Index on `status` filtered for pending notifications
    - Composite index on `director_phone` and `status`

  4. Important Notes
    - This table acts as a queue for director notifications
    - The sales agent writes pending notifications, a separate process sends them
    - Only service_role can access this table (no end-user access)
*/

CREATE TABLE IF NOT EXISTS director_pending_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  director_phone text NOT NULL,
  notification_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);

ALTER TABLE director_pending_notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role can select director notifications"
  ON director_pending_notifications
  FOR SELECT
  TO service_role
  USING (true);

CREATE POLICY "Service role can insert director notifications"
  ON director_pending_notifications
  FOR INSERT
  TO service_role
  WITH CHECK (true);

CREATE POLICY "Service role can update director notifications"
  ON director_pending_notifications
  FOR UPDATE
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Service role can delete director notifications"
  ON director_pending_notifications
  FOR DELETE
  TO service_role
  USING (true);

CREATE INDEX IF NOT EXISTS idx_director_notifications_pending
  ON director_pending_notifications (status) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_director_notifications_phone_status
  ON director_pending_notifications (director_phone, status);
