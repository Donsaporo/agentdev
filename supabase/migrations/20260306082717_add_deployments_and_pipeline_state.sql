/*
  # Add Deployments Tracking and Pipeline State

  1. New Tables
    - `deployments`
      - `id` (uuid, primary key)
      - `project_id` (uuid, FK to projects)
      - `vercel_deployment_id` (text) - Vercel's deployment identifier
      - `commit_sha` (text) - Git commit SHA deployed
      - `url` (text) - Deployment URL
      - `status` (text) - ready, building, error, cancelled
      - `build_duration_seconds` (integer) - How long the build took
      - `triggered_by` (text) - auto, manual, qa_fix
      - `build_logs` (text) - Last build output excerpt
      - `created_at` (timestamptz)
    - `pipeline_state`
      - `id` (uuid, primary key)
      - `project_id` (uuid, FK to projects, unique)
      - `brief_id` (uuid) - Which brief is being processed
      - `current_phase` (text) - analysis, scaffolding, backend_setup, development, completeness_check, build_verify, deployment, qa
      - `phase_data` (jsonb) - Serialized state for the current phase
      - `modules_completed` (jsonb) - Array of completed module names
      - `repo_full_name` (text) - GitHub repo full name
      - `started_at` (timestamptz)
      - `last_checkpoint` (timestamptz)
      - `status` (text) - running, paused, failed, completed
      - `created_at` (timestamptz)

  2. Security
    - Enable RLS on both tables
    - Add policies for authenticated team members
*/

CREATE TABLE IF NOT EXISTS deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id),
  vercel_deployment_id text DEFAULT '',
  commit_sha text DEFAULT '',
  url text DEFAULT '',
  status text DEFAULT 'building',
  build_duration_seconds integer DEFAULT 0,
  triggered_by text DEFAULT 'auto',
  build_logs text DEFAULT '',
  created_at timestamptz DEFAULT now()
);

ALTER TABLE deployments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Team members can view deployments"
  ON deployments FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM team_members WHERE team_members.id = auth.uid()
    )
  );

CREATE POLICY "Team members can insert deployments"
  ON deployments FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM team_members WHERE team_members.id = auth.uid()
    )
  );

CREATE POLICY "Team members can update deployments"
  ON deployments FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM team_members WHERE team_members.id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM team_members WHERE team_members.id = auth.uid()
    )
  );

CREATE TABLE IF NOT EXISTS pipeline_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) UNIQUE,
  brief_id uuid DEFAULT gen_random_uuid(),
  current_phase text DEFAULT 'analysis',
  phase_data jsonb DEFAULT '{}',
  modules_completed jsonb DEFAULT '[]',
  repo_full_name text DEFAULT '',
  started_at timestamptz DEFAULT now(),
  last_checkpoint timestamptz DEFAULT now(),
  status text DEFAULT 'running',
  created_at timestamptz DEFAULT now()
);

ALTER TABLE pipeline_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Team members can view pipeline state"
  ON pipeline_state FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM team_members WHERE team_members.id = auth.uid()
    )
  );

CREATE POLICY "Team members can manage pipeline state"
  ON pipeline_state FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM team_members WHERE team_members.id = auth.uid()
    )
  );

CREATE POLICY "Team members can update pipeline state"
  ON pipeline_state FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM team_members WHERE team_members.id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM team_members WHERE team_members.id = auth.uid()
    )
  );

CREATE INDEX IF NOT EXISTS idx_deployments_project_id ON deployments(project_id);
CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status);
CREATE INDEX IF NOT EXISTS idx_deployments_created_at ON deployments(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_state_project_id ON pipeline_state(project_id);
