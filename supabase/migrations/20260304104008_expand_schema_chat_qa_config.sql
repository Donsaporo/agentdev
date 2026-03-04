/*
  # Expand Schema - Chat, QA Screenshots, Agent Config

  1. New Tables
    - `agent_conversations` - Chat conversation threads per project
      - `id` (uuid, primary key)
      - `project_id` (uuid, references projects)
      - `title` (text) - conversation title
      - `status` (text) - active, archived
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)
    - `agent_messages` - Individual chat messages
      - `id` (uuid, primary key)
      - `conversation_id` (uuid, references agent_conversations)
      - `role` (text) - user, assistant, system
      - `content` (text) - message text
      - `metadata` (jsonb) - code blocks, images, etc
      - `created_at` (timestamptz)
    - `qa_screenshots` - QA visual review screenshots
      - `id` (uuid, primary key)
      - `project_id` (uuid, references projects)
      - `task_id` (uuid, references project_tasks, nullable)
      - `page_name` (text) - e.g. Home, About
      - `page_url` (text) - captured URL
      - `desktop_url` (text) - screenshot URL 1920px
      - `tablet_url` (text) - screenshot URL 768px
      - `mobile_url` (text) - screenshot URL 375px
      - `status` (text) - pending, approved, rejected
      - `rejection_notes` (text) - reason if rejected
      - `version_number` (integer) - v1, v2, v3...
      - `created_at` (timestamptz)
    - `agent_config` - Global agent configuration key/value store
      - `id` (uuid, primary key)
      - `key` (text, unique) - config key name
      - `value` (jsonb) - config value
      - `updated_at` (timestamptz)

  2. Modified Tables
    - `projects` - Added `agent_status` and `current_phase` columns
    - `project_tasks` - Added `duration_seconds` column

  3. Security
    - RLS enabled on all new tables
    - All policies restrict to authenticated team members
    - Service role can bypass RLS for backend agent operations

  4. Realtime
    - Enabled on agent_messages, project_tasks, agent_logs, projects
*/

-- Agent conversations table
CREATE TABLE IF NOT EXISTS agent_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'New Conversation',
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE agent_conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Team members can view conversations"
  ON agent_conversations FOR SELECT
  TO authenticated
  USING (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE POLICY "Team members can insert conversations"
  ON agent_conversations FOR INSERT
  TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE POLICY "Team members can update conversations"
  ON agent_conversations FOR UPDATE
  TO authenticated
  USING (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE POLICY "Team members can delete conversations"
  ON agent_conversations FOR DELETE
  TO authenticated
  USING (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

-- Agent messages table
CREATE TABLE IF NOT EXISTS agent_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES agent_conversations(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'user',
  content text NOT NULL DEFAULT '',
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE agent_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Team members can view messages"
  ON agent_messages FOR SELECT
  TO authenticated
  USING (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE POLICY "Team members can insert messages"
  ON agent_messages FOR INSERT
  TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE POLICY "Team members can update messages"
  ON agent_messages FOR UPDATE
  TO authenticated
  USING (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE POLICY "Team members can delete messages"
  ON agent_messages FOR DELETE
  TO authenticated
  USING (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

-- QA screenshots table
CREATE TABLE IF NOT EXISTS qa_screenshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  task_id uuid REFERENCES project_tasks(id) ON DELETE SET NULL,
  page_name text NOT NULL DEFAULT '',
  page_url text NOT NULL DEFAULT '',
  desktop_url text DEFAULT '',
  tablet_url text DEFAULT '',
  mobile_url text DEFAULT '',
  status text NOT NULL DEFAULT 'pending',
  rejection_notes text DEFAULT '',
  version_number integer NOT NULL DEFAULT 1,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE qa_screenshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Team members can view screenshots"
  ON qa_screenshots FOR SELECT
  TO authenticated
  USING (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE POLICY "Team members can insert screenshots"
  ON qa_screenshots FOR INSERT
  TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE POLICY "Team members can update screenshots"
  ON qa_screenshots FOR UPDATE
  TO authenticated
  USING (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE POLICY "Team members can delete screenshots"
  ON qa_screenshots FOR DELETE
  TO authenticated
  USING (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

-- Agent config table
CREATE TABLE IF NOT EXISTS agent_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text UNIQUE NOT NULL,
  value jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE agent_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Team members can view agent config"
  ON agent_config FOR SELECT
  TO authenticated
  USING (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE POLICY "Team members can insert agent config"
  ON agent_config FOR INSERT
  TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE POLICY "Team members can update agent config"
  ON agent_config FOR UPDATE
  TO authenticated
  USING (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

-- Add new columns to projects
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'projects' AND column_name = 'agent_status'
  ) THEN
    ALTER TABLE projects ADD COLUMN agent_status text NOT NULL DEFAULT 'idle';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'projects' AND column_name = 'current_phase'
  ) THEN
    ALTER TABLE projects ADD COLUMN current_phase text NOT NULL DEFAULT 'analysis';
  END IF;
END $$;

-- Add duration_seconds to project_tasks
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'project_tasks' AND column_name = 'duration_seconds'
  ) THEN
    ALTER TABLE project_tasks ADD COLUMN duration_seconds integer NOT NULL DEFAULT 0;
  END IF;
END $$;

-- Indexes for new tables
CREATE INDEX IF NOT EXISTS idx_conversations_project_id ON agent_conversations(project_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON agent_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON agent_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_qa_screenshots_project_id ON qa_screenshots(project_id);
CREATE INDEX IF NOT EXISTS idx_qa_screenshots_status ON qa_screenshots(status);
CREATE INDEX IF NOT EXISTS idx_agent_config_key ON agent_config(key);

-- Trigger for agent_conversations updated_at
CREATE TRIGGER set_conversations_updated_at
  BEFORE UPDATE ON agent_conversations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Enable realtime on key tables
ALTER PUBLICATION supabase_realtime ADD TABLE agent_messages;
ALTER PUBLICATION supabase_realtime ADD TABLE project_tasks;
ALTER PUBLICATION supabase_realtime ADD TABLE agent_logs;
ALTER PUBLICATION supabase_realtime ADD TABLE projects;
ALTER PUBLICATION supabase_realtime ADD TABLE qa_screenshots;

-- Insert default agent config values
INSERT INTO agent_config (key, value) VALUES
  ('default_model', '"claude-sonnet-4-20250514"'::jsonb),
  ('auto_deploy', 'false'::jsonb),
  ('max_corrections', '3'::jsonb),
  ('auto_qa', 'true'::jsonb),
  ('notification_email', '"team@obzide.com"'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Create storage bucket for QA screenshots
INSERT INTO storage.buckets (id, name, public)
VALUES ('qa-screenshots', 'qa-screenshots', true)
ON CONFLICT (id) DO NOTHING;

-- Storage policies for qa-screenshots bucket
CREATE POLICY "Team members can upload QA screenshots"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'qa-screenshots'
    AND EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid())
  );

CREATE POLICY "Anyone can view QA screenshots"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'qa-screenshots'
    AND EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid())
  );

CREATE POLICY "Team members can delete QA screenshots"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'qa-screenshots'
    AND EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid())
  );