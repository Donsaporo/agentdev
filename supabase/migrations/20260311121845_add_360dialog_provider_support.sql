/*
  # Add 360dialog Provider Support

  1. Modified Tables
    - `whatsapp_business_accounts`
      - `provider` (text) - API provider: 'cloud_api' or '360dialog'. Defaults to 'cloud_api'
      - `channel_id` (text) - 360dialog channel ID
      - `api_base_url` (text) - Provider API base URL for routing calls

  2. Notes
    - Existing accounts default to 'cloud_api' provider
    - 360dialog accounts use the access_token field to store the D360 API key
    - channel_id is specific to 360dialog accounts
    - api_base_url allows per-account endpoint configuration
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'whatsapp_business_accounts' AND column_name = 'provider'
  ) THEN
    ALTER TABLE whatsapp_business_accounts
      ADD COLUMN provider text NOT NULL DEFAULT 'cloud_api';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'whatsapp_business_accounts' AND column_name = 'channel_id'
  ) THEN
    ALTER TABLE whatsapp_business_accounts
      ADD COLUMN channel_id text NOT NULL DEFAULT '';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'whatsapp_business_accounts' AND column_name = 'api_base_url'
  ) THEN
    ALTER TABLE whatsapp_business_accounts
      ADD COLUMN api_base_url text NOT NULL DEFAULT '';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_whatsapp_business_accounts_provider
  ON whatsapp_business_accounts(provider);
