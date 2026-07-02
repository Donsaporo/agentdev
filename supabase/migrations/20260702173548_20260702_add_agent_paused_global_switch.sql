ALTER TABLE sales_agent_heartbeat
  ADD COLUMN IF NOT EXISTS agent_paused boolean DEFAULT false;
