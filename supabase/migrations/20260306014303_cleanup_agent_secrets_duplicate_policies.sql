/*
  # Cleanup duplicate agent_secrets policies

  1. Changes
    - Remove duplicate "Authenticated users can..." policies that overlap with "Team members can..." policies
    - Keep the team_members check as the canonical access control

  2. Important Notes
    - Both sets were PERMISSIVE so they OR'd together, causing no security issue
    - Simplifying to one set of policies for clarity
*/

DROP POLICY IF EXISTS "Authenticated users can view secrets" ON agent_secrets;
DROP POLICY IF EXISTS "Authenticated users can update secrets" ON agent_secrets;
DROP POLICY IF EXISTS "Authenticated users can insert secrets" ON agent_secrets;
