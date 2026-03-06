/*
  # Add Agent Secrets and Heartbeat Tables

  1. New Tables
    - `agent_secrets` - Stores API keys and secrets for external services
      - `id` (uuid, primary key)
      - `service_name` (text, unique) - e.g. anthropic, github, vercel
      - `secret_value` (text) - encrypted API key value
      - `status` (text) - connected, error, untested
      - `status_message` (text) - human-readable status
      - `last_tested` (timestamptz) - when the secret was last validated
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)
    - `agent_heartbeat` - Tracks agent online/offline status
      - `id` (integer, primary key)
      - `last_seen` (timestamptz) - last heartbeat timestamp
      - `status` (text) - online, offline
      - `version` (text) - agent version string
      - `updated_at` (timestamptz)

  2. Security
    - RLS enabled on both tables
    - Only authenticated team members can read secrets (not the values ideally, but the agent uses service_role)
    - Heartbeat readable by team members

  3. Important Notes
    - agent_secrets uses service_name as unique constraint
    - agent_heartbeat is a single-row table (id=1)
    - The agent backend uses service_role_key which bypasses RLS
*/

CREATE TABLE IF NOT EXISTS agent_secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_name text UNIQUE NOT NULL,
  secret_value text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'untested',
  status_message text DEFAULT '',
  last_tested timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE agent_secrets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Team members can view agent secrets"
  ON agent_secrets FOR SELECT
  TO authenticated
  USING (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE POLICY "Team members can insert agent secrets"
  ON agent_secrets FOR INSERT
  TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE POLICY "Team members can update agent secrets"
  ON agent_secrets FOR UPDATE
  TO authenticated
  USING (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE POLICY "Team members can delete agent secrets"
  ON agent_secrets FOR DELETE
  TO authenticated
  USING (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE TABLE IF NOT EXISTS agent_heartbeat (
  id integer PRIMARY KEY DEFAULT 1,
  last_seen timestamptz DEFAULT now(),
  status text NOT NULL DEFAULT 'offline',
  version text DEFAULT '1.0.0',
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE agent_heartbeat ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Team members can view agent heartbeat"
  ON agent_heartbeat FOR SELECT
  TO authenticated
  USING (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE POLICY "Team members can insert agent heartbeat"
  ON agent_heartbeat FOR INSERT
  TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE POLICY "Team members can update agent heartbeat"
  ON agent_heartbeat FOR UPDATE
  TO authenticated
  USING (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE INDEX IF NOT EXISTS idx_agent_secrets_service_name ON agent_secrets(service_name);

CREATE TRIGGER set_agent_secrets_updated_at
  BEFORE UPDATE ON agent_secrets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

INSERT INTO agent_heartbeat (id, last_seen, status, version)
VALUES (1, now(), 'offline', '1.0.0')
ON CONFLICT (id) DO NOTHING;
