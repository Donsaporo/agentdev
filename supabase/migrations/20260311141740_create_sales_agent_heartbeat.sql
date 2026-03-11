/*
  # Create separate heartbeat table for sales agent

  1. New Tables
    - `sales_agent_heartbeat`
      - `id` (text, primary key) - Agent identifier like 'sales-agent'
      - `status` (text) - 'online' or 'offline'
      - `last_seen` (timestamptz) - Last heartbeat timestamp
      - `version` (text) - Agent version string
      - `uptime_started` (timestamptz) - When the agent started

  2. Purpose
    - Separates the sales agent heartbeat from the dev agent heartbeat table
    - Each agent system has its own independent heartbeat tracking
    - Prevents conflicts between different agent processes

  3. Security
    - Enable RLS on the table
    - Only service role can read/write (no public access needed)
*/

CREATE TABLE IF NOT EXISTS sales_agent_heartbeat (
  id text PRIMARY KEY,
  status text NOT NULL DEFAULT 'offline',
  last_seen timestamptz NOT NULL DEFAULT now(),
  version text NOT NULL DEFAULT '1.0.0',
  uptime_started timestamptz
);

ALTER TABLE sales_agent_heartbeat ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access to sales_agent_heartbeat"
  ON sales_agent_heartbeat
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can view sales_agent_heartbeat"
  ON sales_agent_heartbeat
  FOR SELECT
  TO authenticated
  USING (true);

INSERT INTO sales_agent_heartbeat (id, status, version)
VALUES ('sales-agent', 'offline', '1.0.0')
ON CONFLICT (id) DO NOTHING;
