/*
  # Set briefs table replica identity to FULL

  1. Changes
    - Sets REPLICA IDENTITY FULL on `briefs` table
    - This ensures realtime UPDATE events include the old record values
    - Required for the agent to detect status transitions (e.g. old.status != 'in_progress')
      and prevent infinite re-processing loops

  2. Important Notes
    - No data loss or schema changes
    - Only affects how WAL records are written for replication
*/

ALTER TABLE briefs REPLICA IDENTITY FULL;
