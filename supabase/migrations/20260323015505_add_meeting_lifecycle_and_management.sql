/*
  # Add meeting lifecycle management fields

  1. Modified Tables
    - `sales_meetings`
      - `cancellation_reason` (text) - reason for cancellation
      - `cancelled_at` (timestamptz) - when the meeting was cancelled
      - `completed_at` (timestamptz) - when the meeting was marked completed
      - `rescheduled_from` (uuid, FK self-reference) - links to the original meeting that was rescheduled
      - `meeting_type` (text) - 'virtual' or 'presencial'
      - `location` (text) - physical location for presencial meetings

  2. Data Fix
    - Update past meetings still in 'scheduled' status to 'completed'

  3. Indexes
    - Index on rescheduled_from for quick lookups
    - Index on status + start_time for lifecycle queries
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sales_meetings' AND column_name = 'cancellation_reason'
  ) THEN
    ALTER TABLE sales_meetings ADD COLUMN cancellation_reason text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sales_meetings' AND column_name = 'cancelled_at'
  ) THEN
    ALTER TABLE sales_meetings ADD COLUMN cancelled_at timestamptz;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sales_meetings' AND column_name = 'completed_at'
  ) THEN
    ALTER TABLE sales_meetings ADD COLUMN completed_at timestamptz;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sales_meetings' AND column_name = 'rescheduled_from'
  ) THEN
    ALTER TABLE sales_meetings ADD COLUMN rescheduled_from uuid REFERENCES sales_meetings(id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sales_meetings' AND column_name = 'meeting_type'
  ) THEN
    ALTER TABLE sales_meetings ADD COLUMN meeting_type text DEFAULT 'virtual';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sales_meetings' AND column_name = 'location'
  ) THEN
    ALTER TABLE sales_meetings ADD COLUMN location text;
  END IF;
END $$;

UPDATE sales_meetings
SET status = 'completed',
    completed_at = end_time,
    updated_at = now()
WHERE status = 'scheduled'
  AND end_time < (now() - interval '30 minutes');

CREATE INDEX IF NOT EXISTS idx_sales_meetings_rescheduled_from ON sales_meetings(rescheduled_from);
CREATE INDEX IF NOT EXISTS idx_sales_meetings_status_start ON sales_meetings(status, start_time);
