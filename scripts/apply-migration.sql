/*
  # Add Agent Secrets and Token Usage Tables

  Run this SQL in the Supabase SQL Editor (Dashboard > SQL Editor)

  1. New Tables
    - `agent_secrets` - stores API keys with auto-masking
    - `token_usage` - tracks AI token consumption per project

  2. Security
    - RLS enabled on both tables
    - Authenticated users can manage secrets and view usage

  3. Auto-masking trigger
    - Automatically masks secret values on insert/update
*/

CREATE TABLE IF NOT EXISTS agent_secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_name text UNIQUE NOT NULL,
  service_label text NOT NULL DEFAULT '',
  secret_value text NOT NULL DEFAULT '',
  masked_value text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'untested',
  status_message text NOT NULL DEFAULT '',
  last_tested timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE agent_secrets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view secrets"
  ON agent_secrets FOR SELECT
  TO authenticated
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can update secrets"
  ON agent_secrets FOR UPDATE
  TO authenticated
  USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can insert secrets"
  ON agent_secrets FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE OR REPLACE FUNCTION mask_secret_value()
RETURNS TRIGGER AS $$
BEGIN
  IF length(NEW.secret_value) > 4 THEN
    NEW.masked_value := '****' || right(NEW.secret_value, 4);
  ELSE
    NEW.masked_value := '****';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_mask_secret ON agent_secrets;
CREATE TRIGGER trigger_mask_secret
  BEFORE INSERT OR UPDATE OF secret_value ON agent_secrets
  FOR EACH ROW
  EXECUTE FUNCTION mask_secret_value();

INSERT INTO agent_secrets (service_name, service_label) VALUES
  ('anthropic', 'Claude API (Anthropic)'),
  ('github', 'GitHub Personal Access Token'),
  ('github_org', 'GitHub Organization'),
  ('vercel', 'Vercel API Token'),
  ('vercel_team_id', 'Vercel Team ID'),
  ('namecheap', 'Namecheap API Key'),
  ('namecheap_user', 'Namecheap Username'),
  ('resend', 'Resend API Key'),
  ('brave', 'Brave Search API Key')
ON CONFLICT (service_name) DO NOTHING;

CREATE TABLE IF NOT EXISTS token_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  model text NOT NULL DEFAULT '',
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cost_estimate numeric(10, 6) NOT NULL DEFAULT 0,
  operation text NOT NULL DEFAULT '',
  created_at timestamptz DEFAULT now()
);

ALTER TABLE token_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view token usage"
  ON token_usage FOR SELECT
  TO authenticated
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can insert token usage"
  ON token_usage FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_token_usage_project_id ON token_usage(project_id);
CREATE INDEX IF NOT EXISTS idx_token_usage_created_at ON token_usage(created_at DESC);
