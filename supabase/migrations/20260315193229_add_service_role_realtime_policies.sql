/*
  # Add service_role SELECT policies for Realtime subscriptions

  1. Changes
    - Add SELECT policy for `service_role` on `whatsapp_messages` table
    - Add SELECT policy for `service_role` on `whatsapp_conversations` table
    - Add SELECT policy for `service_role` on `sales_agent_instructions` table
    - Add SELECT policy for `service_role` on `whatsapp_contacts` table

  2. Why
    - Supabase Realtime uses the `supabase_realtime_admin` role internally,
      but postgres_changes events are filtered through RLS policies.
    - The service_role key used by backend agents (sales-agent, dev-agent)
      bypasses RLS for direct queries but NOT for Realtime event delivery.
    - Without explicit SELECT policies for service_role, Realtime events
      silently fail to reach the backend agents.

  3. Security
    - service_role is a server-side only key, never exposed to clients
    - These policies only grant SELECT (read) access
    - This matches the existing pattern on sales_agent_heartbeat table
*/

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'whatsapp_messages' 
    AND policyname = 'Service role can read whatsapp_messages'
  ) THEN
    CREATE POLICY "Service role can read whatsapp_messages"
      ON whatsapp_messages
      FOR SELECT
      TO service_role
      USING (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'whatsapp_conversations' 
    AND policyname = 'Service role can read whatsapp_conversations'
  ) THEN
    CREATE POLICY "Service role can read whatsapp_conversations"
      ON whatsapp_conversations
      FOR SELECT
      TO service_role
      USING (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'sales_agent_instructions' 
    AND policyname = 'Service role can read sales_agent_instructions'
  ) THEN
    CREATE POLICY "Service role can read sales_agent_instructions"
      ON sales_agent_instructions
      FOR SELECT
      TO service_role
      USING (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'whatsapp_contacts' 
    AND policyname = 'Service role can read whatsapp_contacts'
  ) THEN
    CREATE POLICY "Service role can read whatsapp_contacts"
      ON whatsapp_contacts
      FOR SELECT
      TO service_role
      USING (true);
  END IF;
END $$;
