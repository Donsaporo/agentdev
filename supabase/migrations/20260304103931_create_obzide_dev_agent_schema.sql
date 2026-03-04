/*
  # Obzide Dev Agent - Complete Database Schema

  1. New Tables
    - `team_members` - Obzide team members (linked to auth.users)
    - `clients` - Client information
    - `projects` - Development projects
    - `briefs` - Client briefs / requirements
    - `project_tasks` - Individual tasks the agent executes
    - `integrations` - API integrations per project
    - `agent_logs` - Activity log from the AI agent
    - `domains` - Domain management

  2. Security
    - RLS enabled on all tables
    - Policies restrict access to authenticated team members only

  3. Important Notes
    - All tables use UUID primary keys with gen_random_uuid()
    - Timestamps default to now()
    - JSONB columns used for flexible structured data
    - Foreign keys maintain referential integrity
*/

CREATE TABLE IF NOT EXISTS team_members (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name text NOT NULL DEFAULT '',
  role text NOT NULL DEFAULT 'developer',
  avatar_url text DEFAULT '',
  created_at timestamptz DEFAULT now()
);

ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Team members can view all team members"
  ON team_members FOR SELECT
  TO authenticated
  USING (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE POLICY "Team members can update own profile"
  ON team_members FOR UPDATE
  TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

CREATE POLICY "Authenticated users can insert own team member record"
  ON team_members FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = id);

CREATE TABLE IF NOT EXISTS clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  contact_name text NOT NULL DEFAULT '',
  contact_email text NOT NULL DEFAULT '',
  contact_phone text DEFAULT '',
  industry text DEFAULT '',
  brand_colors jsonb DEFAULT '[]'::jsonb,
  brand_fonts jsonb DEFAULT '[]'::jsonb,
  notes text DEFAULT '',
  created_by uuid REFERENCES team_members(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE clients ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Team members can view all clients"
  ON clients FOR SELECT
  TO authenticated
  USING (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE POLICY "Team members can insert clients"
  ON clients FOR INSERT
  TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE POLICY "Team members can update clients"
  ON clients FOR UPDATE
  TO authenticated
  USING (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE POLICY "Team members can delete clients"
  ON clients FOR DELETE
  TO authenticated
  USING (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid REFERENCES clients(id) ON DELETE CASCADE,
  name text NOT NULL,
  type text NOT NULL DEFAULT 'website',
  status text NOT NULL DEFAULT 'draft',
  description text DEFAULT '',
  demo_url text DEFAULT '',
  production_url text DEFAULT '',
  vercel_project_id text DEFAULT '',
  git_repo_url text DEFAULT '',
  progress integer NOT NULL DEFAULT 0,
  technologies jsonb DEFAULT '[]'::jsonb,
  created_by uuid REFERENCES team_members(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Team members can view all projects"
  ON projects FOR SELECT
  TO authenticated
  USING (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE POLICY "Team members can insert projects"
  ON projects FOR INSERT
  TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE POLICY "Team members can update projects"
  ON projects FOR UPDATE
  TO authenticated
  USING (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE POLICY "Team members can delete projects"
  ON projects FOR DELETE
  TO authenticated
  USING (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE TABLE IF NOT EXISTS briefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  original_content text NOT NULL DEFAULT '',
  parsed_requirements jsonb DEFAULT '[]'::jsonb,
  pages_screens jsonb DEFAULT '[]'::jsonb,
  features jsonb DEFAULT '[]'::jsonb,
  questions jsonb DEFAULT '[]'::jsonb,
  answers jsonb DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'pending_review',
  architecture_plan jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE briefs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Team members can view all briefs"
  ON briefs FOR SELECT
  TO authenticated
  USING (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE POLICY "Team members can insert briefs"
  ON briefs FOR INSERT
  TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE POLICY "Team members can update briefs"
  ON briefs FOR UPDATE
  TO authenticated
  USING (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE POLICY "Team members can delete briefs"
  ON briefs FOR DELETE
  TO authenticated
  USING (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE TABLE IF NOT EXISTS project_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text DEFAULT '',
  status text NOT NULL DEFAULT 'pending',
  priority integer NOT NULL DEFAULT 3,
  order_index integer NOT NULL DEFAULT 0,
  error_log text DEFAULT '',
  screenshot_url text DEFAULT '',
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE project_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Team members can view all tasks"
  ON project_tasks FOR SELECT
  TO authenticated
  USING (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE POLICY "Team members can insert tasks"
  ON project_tasks FOR INSERT
  TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE POLICY "Team members can update tasks"
  ON project_tasks FOR UPDATE
  TO authenticated
  USING (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE POLICY "Team members can delete tasks"
  ON project_tasks FOR DELETE
  TO authenticated
  USING (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE TABLE IF NOT EXISTS integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  service_name text NOT NULL,
  service_type text NOT NULL DEFAULT 'custom',
  config jsonb DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'configured',
  documentation_url text DEFAULT '',
  notes text DEFAULT '',
  created_at timestamptz DEFAULT now()
);

ALTER TABLE integrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Team members can view all integrations"
  ON integrations FOR SELECT
  TO authenticated
  USING (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE POLICY "Team members can insert integrations"
  ON integrations FOR INSERT
  TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE POLICY "Team members can update integrations"
  ON integrations FOR UPDATE
  TO authenticated
  USING (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE POLICY "Team members can delete integrations"
  ON integrations FOR DELETE
  TO authenticated
  USING (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE TABLE IF NOT EXISTS agent_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  action text NOT NULL,
  category text NOT NULL DEFAULT 'info',
  details jsonb DEFAULT '{}'::jsonb,
  severity text NOT NULL DEFAULT 'info',
  created_at timestamptz DEFAULT now()
);

ALTER TABLE agent_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Team members can view all agent logs"
  ON agent_logs FOR SELECT
  TO authenticated
  USING (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE POLICY "Team members can insert agent logs"
  ON agent_logs FOR INSERT
  TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE TABLE IF NOT EXISTS domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  client_id uuid REFERENCES clients(id) ON DELETE CASCADE,
  domain_name text NOT NULL,
  subdomain text DEFAULT '',
  is_demo boolean NOT NULL DEFAULT false,
  dns_status text NOT NULL DEFAULT 'pending',
  ssl_status text NOT NULL DEFAULT 'pending',
  registrar text DEFAULT 'namecheap',
  nameservers jsonb DEFAULT '[]'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE domains ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Team members can view all domains"
  ON domains FOR SELECT
  TO authenticated
  USING (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE POLICY "Team members can insert domains"
  ON domains FOR INSERT
  TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE POLICY "Team members can update domains"
  ON domains FOR UPDATE
  TO authenticated
  USING (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE POLICY "Team members can delete domains"
  ON domains FOR DELETE
  TO authenticated
  USING (EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = auth.uid()));

CREATE INDEX IF NOT EXISTS idx_projects_client_id ON projects(client_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_briefs_project_id ON briefs(project_id);
CREATE INDEX IF NOT EXISTS idx_project_tasks_project_id ON project_tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_project_tasks_status ON project_tasks(status);
CREATE INDEX IF NOT EXISTS idx_integrations_project_id ON integrations(project_id);
CREATE INDEX IF NOT EXISTS idx_agent_logs_project_id ON agent_logs(project_id);
CREATE INDEX IF NOT EXISTS idx_agent_logs_category ON agent_logs(category);
CREATE INDEX IF NOT EXISTS idx_agent_logs_created_at ON agent_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_domains_client_id ON domains(client_id);
CREATE INDEX IF NOT EXISTS idx_domains_project_id ON domains(project_id);

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER set_briefs_updated_at
  BEFORE UPDATE ON briefs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER set_domains_updated_at
  BEFORE UPDATE ON domains
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();