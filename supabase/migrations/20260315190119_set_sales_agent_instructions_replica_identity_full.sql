/*
  # Set replica identity full on sales_agent_instructions

  1. Changes
    - Set `sales_agent_instructions` table replica identity to FULL
    - Required for Supabase Realtime to work properly with this table
  
  2. Notes
    - Without FULL replica identity, Realtime filters may not work correctly
    - This enables the Realtime subscription used by the sales agent
*/

ALTER TABLE IF EXISTS sales_agent_instructions REPLICA IDENTITY FULL;