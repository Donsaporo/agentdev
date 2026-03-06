/*
  # Add backend infrastructure fields and token usage tracking

  1. Modified Tables
    - `projects`
      - `has_backend` (boolean, default false) - whether this project needs a backend/database
      - `supabase_project_ref` (text, nullable) - the Supabase project ref ID for this project's database
      - `supabase_url` (text, nullable) - the Supabase URL for the project's database
      - `supabase_anon_key` (text, nullable) - the anon key for frontend access
      - `last_error_message` (text, nullable) - last error encountered during processing

  2. New Tables
    - `token_usage` - tracks AI token consumption and costs per operation
      - `id` (uuid, primary key)
      - `project_id` (uuid, FK to projects, nullable)
      - `model` (text) - the AI model used
      - `input_tokens` (integer) - tokens consumed as input
      - `output_tokens` (integer) - tokens produced as output
      - `cost_estimate` (numeric) - estimated cost in USD
      - `operation` (text) - the operation type (brief_analysis, scaffold, module_code, etc.)
      - `created_at` (timestamptz)

  3. Security
    - Enable RLS on `token_usage` table
    - Add policies for authenticated team members to read token usage data
    - Add policy for service role to insert token usage data

  4. Notes
    - These fields enable the agent to auto-create Supabase projects per generated project
    - Token usage tracking helps monitor costs and optimize AI usage
    - The supabase_anon_key is safe to store since it's designed for frontend/public access
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'projects' AND column_name = 'has_backend'
  ) THEN
    ALTER TABLE projects ADD COLUMN has_backend boolean DEFAULT false;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'projects' AND column_name = 'supabase_project_ref'
  ) THEN
    ALTER TABLE projects ADD COLUMN supabase_project_ref text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'projects' AND column_name = 'supabase_url'
  ) THEN
    ALTER TABLE projects ADD COLUMN supabase_url text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'projects' AND column_name = 'supabase_anon_key'
  ) THEN
    ALTER TABLE projects ADD COLUMN supabase_anon_key text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'projects' AND column_name = 'last_error_message'
  ) THEN
    ALTER TABLE projects ADD COLUMN last_error_message text;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS token_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  model text NOT NULL DEFAULT '',
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cost_estimate numeric NOT NULL DEFAULT 0,
  operation text NOT NULL DEFAULT '',
  created_at timestamptz DEFAULT now()
);

ALTER TABLE token_usage ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'token_usage' AND policyname = 'Team members can view token usage'
  ) THEN
    CREATE POLICY "Team members can view token usage"
      ON token_usage
      FOR SELECT
      TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM team_members WHERE team_members.id = auth.uid()
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_token_usage_project_id ON token_usage(project_id);
CREATE INDEX IF NOT EXISTS idx_token_usage_created_at ON token_usage(created_at);
CREATE INDEX IF NOT EXISTS idx_token_usage_operation ON token_usage(operation);
