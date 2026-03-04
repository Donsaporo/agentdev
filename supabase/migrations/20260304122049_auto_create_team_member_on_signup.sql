/*
  # Auto-create team member on signup + seed existing user

  ## Problem
  Users who sign up don't always get a team_members record
  (e.g., if the insert failed due to previous RLS issues).
  Without a team_members record, all RLS policies block access.

  ## Solution
  1. Create a trigger function that automatically inserts a team_members
     record whenever a new user signs up via auth
  2. Seed the existing user into team_members

  ## Changes
  - New function: handle_new_user() (trigger on auth.users)
  - New trigger: on_auth_user_created
  - Insert existing user into team_members
*/

-- Create trigger function to auto-insert team member on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO team_members (id, full_name, role)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data ->> 'full_name', ''),
    'developer'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- Create trigger on auth.users
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- Insert existing user who is missing from team_members
INSERT INTO team_members (id, full_name, role)
SELECT id, COALESCE(raw_user_meta_data ->> 'full_name', email), 'admin'
FROM auth.users
WHERE id NOT IN (SELECT id FROM team_members)
ON CONFLICT (id) DO NOTHING;
