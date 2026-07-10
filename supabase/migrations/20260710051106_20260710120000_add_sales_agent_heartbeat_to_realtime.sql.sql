-- Add sales_agent_heartbeat to the realtime publication so the sales-agent
-- receives UPDATE events when agent_paused is toggled via $apagar/$encender.
ALTER PUBLICATION supabase_realtime ADD TABLE sales_agent_heartbeat;
