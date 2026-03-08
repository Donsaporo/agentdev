/*
  # Add Performance Indexes

  1. New Indexes
    - `agent_logs(project_id, created_at)` - speeds up log queries by project
    - `token_usage(project_id, created_at)` - speeds up cost tracking queries
    - `pipeline_state(project_id, status)` - speeds up checkpoint lookups
    - `project_tasks(project_id, status)` - speeds up task queries during pipeline
    - `briefs(project_id, status)` - speeds up brief lookups

  2. Notes
    - All indexes use IF NOT EXISTS to be idempotent
    - These are critical for pipeline performance as the agent generates hundreds of log entries per build
*/

CREATE INDEX IF NOT EXISTS idx_agent_logs_project_created
  ON agent_logs(project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_token_usage_project_created
  ON token_usage(project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pipeline_state_project_status
  ON pipeline_state(project_id, status);

CREATE INDEX IF NOT EXISTS idx_project_tasks_project_status
  ON project_tasks(project_id, status);

CREATE INDEX IF NOT EXISTS idx_briefs_project_status
  ON briefs(project_id, status);

CREATE INDEX IF NOT EXISTS idx_qa_screenshots_project_version
  ON qa_screenshots(project_id, version_number DESC);

CREATE INDEX IF NOT EXISTS idx_deployments_project_created
  ON deployments(project_id, created_at DESC);
