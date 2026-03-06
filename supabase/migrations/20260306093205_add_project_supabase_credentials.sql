/*
  # Add full Supabase credentials to projects

  1. Modified Tables
    - `projects`
      - `supabase_db_password` (text, nullable) - Generated DB password for the client's Supabase project
      - `supabase_service_role_key` (text, nullable) - Service role key for server-side operations

  2. Important Notes
    - These credentials are generated during backend setup and were previously lost
    - Storing them allows future admin operations on client databases
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'projects' AND column_name = 'supabase_db_password'
  ) THEN
    ALTER TABLE projects ADD COLUMN supabase_db_password text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'projects' AND column_name = 'supabase_service_role_key'
  ) THEN
    ALTER TABLE projects ADD COLUMN supabase_service_role_key text;
  END IF;
END $$;
