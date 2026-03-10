/*
  # Add Supabase project name column

  1. Modified Tables
    - `projects`
      - Added `supabase_project_name` (text, nullable) - human-readable name of the child Supabase project

  2. Notes
    - Stores the friendly name used when creating the Supabase project via Management API
    - Makes it easier to identify projects without relying on UUID refs
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'projects' AND column_name = 'supabase_project_name'
  ) THEN
    ALTER TABLE projects ADD COLUMN supabase_project_name text DEFAULT NULL;
  END IF;
END $$;
