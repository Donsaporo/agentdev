/*
  # Fix foreign key cascading and add DELETE policies

  1. Changes
    - `pipeline_state`: Change project_id FK from NO ACTION to CASCADE on delete
    - `deployments`: Change project_id FK from NO ACTION to CASCADE on delete
    - Add DELETE RLS policy on `pipeline_state` for team members
    - Add DELETE RLS policy on `deployments` for team members

  2. Why
    - Deleting a project was blocked by pipeline_state and deployments rows
      referencing it with NO ACTION. Now they cascade-delete automatically.
    - DELETE RLS policies were missing, preventing authenticated deletes even
      if the FK allowed it.
*/

ALTER TABLE pipeline_state
  DROP CONSTRAINT IF EXISTS pipeline_state_project_id_fkey,
  ADD CONSTRAINT pipeline_state_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE deployments
  DROP CONSTRAINT IF EXISTS deployments_project_id_fkey,
  ADD CONSTRAINT deployments_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'pipeline_state' AND policyname = 'Team members can delete pipeline state'
  ) THEN
    CREATE POLICY "Team members can delete pipeline state"
      ON pipeline_state FOR DELETE
      TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM team_members WHERE team_members.id = auth.uid()
        )
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'deployments' AND policyname = 'Team members can delete deployments'
  ) THEN
    CREATE POLICY "Team members can delete deployments"
      ON deployments FOR DELETE
      TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM team_members WHERE team_members.id = auth.uid()
        )
      );
  END IF;
END $$;