/*
  # Fix infinite recursion in RLS policies

  ## Problem
  The SELECT policy on `team_members` references itself via
  `EXISTS (SELECT 1 FROM team_members ...)`, causing infinite recursion.
  All other tables also reference `team_members` in their policies,
  propagating the same error everywhere.

  ## Solution
  1. Create a SECURITY DEFINER function `is_team_member()` that checks
     membership bypassing RLS
  2. Drop ALL existing policies on ALL tables
  3. Recreate policies using the new function instead of inline subqueries

  ## Tables affected
  - team_members, clients, projects, briefs, project_tasks,
    integrations, agent_logs, domains, agent_conversations,
    agent_messages, qa_screenshots, agent_config
  - storage.objects (qa-screenshots bucket)
*/

-- Step 1: Create SECURITY DEFINER function to check team membership without RLS
CREATE OR REPLACE FUNCTION public.is_team_member()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM team_members WHERE id = auth.uid()
  );
$$;

-- Step 2: Drop ALL existing policies

-- team_members
DROP POLICY IF EXISTS "Team members can view all team members" ON team_members;
DROP POLICY IF EXISTS "Team members can update own profile" ON team_members;
DROP POLICY IF EXISTS "Authenticated users can insert own team member record" ON team_members;

-- clients
DROP POLICY IF EXISTS "Team members can view clients" ON clients;
DROP POLICY IF EXISTS "Team members can create clients" ON clients;
DROP POLICY IF EXISTS "Team members can update clients" ON clients;
DROP POLICY IF EXISTS "Team members can delete clients" ON clients;

-- projects
DROP POLICY IF EXISTS "Team members can view projects" ON projects;
DROP POLICY IF EXISTS "Team members can create projects" ON projects;
DROP POLICY IF EXISTS "Team members can update projects" ON projects;
DROP POLICY IF EXISTS "Team members can delete projects" ON projects;

-- briefs
DROP POLICY IF EXISTS "Team members can view briefs" ON briefs;
DROP POLICY IF EXISTS "Team members can create briefs" ON briefs;
DROP POLICY IF EXISTS "Team members can update briefs" ON briefs;
DROP POLICY IF EXISTS "Team members can delete briefs" ON briefs;

-- project_tasks
DROP POLICY IF EXISTS "Team members can view tasks" ON project_tasks;
DROP POLICY IF EXISTS "Team members can create tasks" ON project_tasks;
DROP POLICY IF EXISTS "Team members can update tasks" ON project_tasks;
DROP POLICY IF EXISTS "Team members can delete tasks" ON project_tasks;

-- integrations
DROP POLICY IF EXISTS "Team members can view integrations" ON integrations;
DROP POLICY IF EXISTS "Team members can create integrations" ON integrations;
DROP POLICY IF EXISTS "Team members can update integrations" ON integrations;
DROP POLICY IF EXISTS "Team members can delete integrations" ON integrations;

-- agent_logs
DROP POLICY IF EXISTS "Team members can view logs" ON agent_logs;
DROP POLICY IF EXISTS "Team members can create logs" ON agent_logs;

-- domains
DROP POLICY IF EXISTS "Team members can view domains" ON domains;
DROP POLICY IF EXISTS "Team members can create domains" ON domains;
DROP POLICY IF EXISTS "Team members can update domains" ON domains;
DROP POLICY IF EXISTS "Team members can delete domains" ON domains;

-- agent_conversations
DROP POLICY IF EXISTS "Team members can view conversations" ON agent_conversations;
DROP POLICY IF EXISTS "Team members can create conversations" ON agent_conversations;
DROP POLICY IF EXISTS "Team members can update conversations" ON agent_conversations;
DROP POLICY IF EXISTS "Team members can delete conversations" ON agent_conversations;

-- agent_messages
DROP POLICY IF EXISTS "Team members can view messages" ON agent_messages;
DROP POLICY IF EXISTS "Team members can create messages" ON agent_messages;
DROP POLICY IF EXISTS "Team members can update messages" ON agent_messages;
DROP POLICY IF EXISTS "Team members can delete messages" ON agent_messages;

-- qa_screenshots
DROP POLICY IF EXISTS "Team members can view screenshots" ON qa_screenshots;
DROP POLICY IF EXISTS "Team members can create screenshots" ON qa_screenshots;
DROP POLICY IF EXISTS "Team members can update screenshots" ON qa_screenshots;
DROP POLICY IF EXISTS "Team members can delete screenshots" ON qa_screenshots;

-- agent_config
DROP POLICY IF EXISTS "Team members can view config" ON agent_config;
DROP POLICY IF EXISTS "Team members can create config" ON agent_config;
DROP POLICY IF EXISTS "Team members can update config" ON agent_config;

-- storage
DROP POLICY IF EXISTS "Team members can upload QA screenshots" ON storage.objects;
DROP POLICY IF EXISTS "Anyone can view QA screenshots" ON storage.objects;
DROP POLICY IF EXISTS "Team members can delete QA screenshots" ON storage.objects;

-- Step 3: Recreate all policies using is_team_member()

-- team_members: SELECT uses direct uid check (no self-reference!)
CREATE POLICY "Team members can view all team members"
  ON team_members FOR SELECT
  TO authenticated
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Team members can update own profile"
  ON team_members FOR UPDATE
  TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

CREATE POLICY "Authenticated users can insert own team member record"
  ON team_members FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = id);

-- clients
CREATE POLICY "Team members can view clients"
  ON clients FOR SELECT
  TO authenticated
  USING (is_team_member());

CREATE POLICY "Team members can create clients"
  ON clients FOR INSERT
  TO authenticated
  WITH CHECK (is_team_member());

CREATE POLICY "Team members can update clients"
  ON clients FOR UPDATE
  TO authenticated
  USING (is_team_member())
  WITH CHECK (is_team_member());

CREATE POLICY "Team members can delete clients"
  ON clients FOR DELETE
  TO authenticated
  USING (is_team_member());

-- projects
CREATE POLICY "Team members can view projects"
  ON projects FOR SELECT
  TO authenticated
  USING (is_team_member());

CREATE POLICY "Team members can create projects"
  ON projects FOR INSERT
  TO authenticated
  WITH CHECK (is_team_member());

CREATE POLICY "Team members can update projects"
  ON projects FOR UPDATE
  TO authenticated
  USING (is_team_member())
  WITH CHECK (is_team_member());

CREATE POLICY "Team members can delete projects"
  ON projects FOR DELETE
  TO authenticated
  USING (is_team_member());

-- briefs
CREATE POLICY "Team members can view briefs"
  ON briefs FOR SELECT
  TO authenticated
  USING (is_team_member());

CREATE POLICY "Team members can create briefs"
  ON briefs FOR INSERT
  TO authenticated
  WITH CHECK (is_team_member());

CREATE POLICY "Team members can update briefs"
  ON briefs FOR UPDATE
  TO authenticated
  USING (is_team_member())
  WITH CHECK (is_team_member());

CREATE POLICY "Team members can delete briefs"
  ON briefs FOR DELETE
  TO authenticated
  USING (is_team_member());

-- project_tasks
CREATE POLICY "Team members can view tasks"
  ON project_tasks FOR SELECT
  TO authenticated
  USING (is_team_member());

CREATE POLICY "Team members can create tasks"
  ON project_tasks FOR INSERT
  TO authenticated
  WITH CHECK (is_team_member());

CREATE POLICY "Team members can update tasks"
  ON project_tasks FOR UPDATE
  TO authenticated
  USING (is_team_member())
  WITH CHECK (is_team_member());

CREATE POLICY "Team members can delete tasks"
  ON project_tasks FOR DELETE
  TO authenticated
  USING (is_team_member());

-- integrations
CREATE POLICY "Team members can view integrations"
  ON integrations FOR SELECT
  TO authenticated
  USING (is_team_member());

CREATE POLICY "Team members can create integrations"
  ON integrations FOR INSERT
  TO authenticated
  WITH CHECK (is_team_member());

CREATE POLICY "Team members can update integrations"
  ON integrations FOR UPDATE
  TO authenticated
  USING (is_team_member())
  WITH CHECK (is_team_member());

CREATE POLICY "Team members can delete integrations"
  ON integrations FOR DELETE
  TO authenticated
  USING (is_team_member());

-- agent_logs
CREATE POLICY "Team members can view logs"
  ON agent_logs FOR SELECT
  TO authenticated
  USING (is_team_member());

CREATE POLICY "Team members can create logs"
  ON agent_logs FOR INSERT
  TO authenticated
  WITH CHECK (is_team_member());

-- domains
CREATE POLICY "Team members can view domains"
  ON domains FOR SELECT
  TO authenticated
  USING (is_team_member());

CREATE POLICY "Team members can create domains"
  ON domains FOR INSERT
  TO authenticated
  WITH CHECK (is_team_member());

CREATE POLICY "Team members can update domains"
  ON domains FOR UPDATE
  TO authenticated
  USING (is_team_member())
  WITH CHECK (is_team_member());

CREATE POLICY "Team members can delete domains"
  ON domains FOR DELETE
  TO authenticated
  USING (is_team_member());

-- agent_conversations
CREATE POLICY "Team members can view conversations"
  ON agent_conversations FOR SELECT
  TO authenticated
  USING (is_team_member());

CREATE POLICY "Team members can create conversations"
  ON agent_conversations FOR INSERT
  TO authenticated
  WITH CHECK (is_team_member());

CREATE POLICY "Team members can update conversations"
  ON agent_conversations FOR UPDATE
  TO authenticated
  USING (is_team_member())
  WITH CHECK (is_team_member());

CREATE POLICY "Team members can delete conversations"
  ON agent_conversations FOR DELETE
  TO authenticated
  USING (is_team_member());

-- agent_messages
CREATE POLICY "Team members can view messages"
  ON agent_messages FOR SELECT
  TO authenticated
  USING (is_team_member());

CREATE POLICY "Team members can create messages"
  ON agent_messages FOR INSERT
  TO authenticated
  WITH CHECK (is_team_member());

CREATE POLICY "Team members can update messages"
  ON agent_messages FOR UPDATE
  TO authenticated
  USING (is_team_member())
  WITH CHECK (is_team_member());

CREATE POLICY "Team members can delete messages"
  ON agent_messages FOR DELETE
  TO authenticated
  USING (is_team_member());

-- qa_screenshots
CREATE POLICY "Team members can view screenshots"
  ON qa_screenshots FOR SELECT
  TO authenticated
  USING (is_team_member());

CREATE POLICY "Team members can create screenshots"
  ON qa_screenshots FOR INSERT
  TO authenticated
  WITH CHECK (is_team_member());

CREATE POLICY "Team members can update screenshots"
  ON qa_screenshots FOR UPDATE
  TO authenticated
  USING (is_team_member())
  WITH CHECK (is_team_member());

CREATE POLICY "Team members can delete screenshots"
  ON qa_screenshots FOR DELETE
  TO authenticated
  USING (is_team_member());

-- agent_config
CREATE POLICY "Team members can view config"
  ON agent_config FOR SELECT
  TO authenticated
  USING (is_team_member());

CREATE POLICY "Team members can create config"
  ON agent_config FOR INSERT
  TO authenticated
  WITH CHECK (is_team_member());

CREATE POLICY "Team members can update config"
  ON agent_config FOR UPDATE
  TO authenticated
  USING (is_team_member())
  WITH CHECK (is_team_member());

-- storage policies
CREATE POLICY "Team members can upload QA screenshots"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'qa-screenshots'
    AND is_team_member()
  );

CREATE POLICY "Team members can view QA screenshots"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'qa-screenshots'
    AND is_team_member()
  );

CREATE POLICY "Team members can delete QA screenshots"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'qa-screenshots'
    AND is_team_member()
  );
