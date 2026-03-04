/*
  # Add Realtime for Briefs and Conversations

  1. Changes
    - Enable realtime on `briefs` table so the agent can listen for status changes
    - Enable realtime on `agent_conversations` table for live conversation updates

  2. Important Notes
    - The agent backend needs to subscribe to briefs INSERT/UPDATE events
    - This complements the existing realtime on agent_messages, project_tasks, agent_logs, projects, qa_screenshots
*/

ALTER PUBLICATION supabase_realtime ADD TABLE briefs;
ALTER PUBLICATION supabase_realtime ADD TABLE agent_conversations;
