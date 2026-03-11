/*
  # Create WhatsApp Business Accounts Table

  1. New Tables
    - `whatsapp_business_accounts`
      - `id` (uuid, primary key)
      - `waba_id` (text) - WhatsApp Business Account ID from Meta
      - `phone_number_id` (text) - Phone Number ID registered via Embedded Signup
      - `display_phone_number` (text) - Formatted display phone number
      - `verified_name` (text) - Business verified name from Meta
      - `quality_rating` (text) - Account quality rating
      - `access_token` (text) - System User Access Token (encrypted at rest by Supabase)
      - `meta_app_id` (text) - Facebook App ID used for the connection
      - `configuration_id` (text) - Embedded Signup Configuration ID
      - `status` (text) - Connection status: connected, disconnected, error
      - `status_message` (text) - Descriptive status or error message
      - `connected_by` (uuid) - Team member who connected the account
      - `connected_at` (timestamptz) - When the account was connected
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)

  2. Security
    - Enable RLS on `whatsapp_business_accounts` table
    - Authenticated team members can read accounts
    - Authenticated team members can insert new accounts
    - Authenticated team members can update accounts
    - Authenticated team members can delete accounts
*/

CREATE TABLE IF NOT EXISTS whatsapp_business_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  waba_id text NOT NULL DEFAULT '',
  phone_number_id text NOT NULL DEFAULT '',
  display_phone_number text NOT NULL DEFAULT '',
  verified_name text NOT NULL DEFAULT '',
  quality_rating text NOT NULL DEFAULT 'unknown',
  access_token text NOT NULL DEFAULT '',
  meta_app_id text NOT NULL DEFAULT '',
  configuration_id text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending',
  status_message text NOT NULL DEFAULT '',
  connected_by uuid REFERENCES auth.users(id),
  connected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE whatsapp_business_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Team members can read whatsapp accounts"
  ON whatsapp_business_accounts
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM team_members
      WHERE team_members.id = auth.uid()
    )
  );

CREATE POLICY "Team members can insert whatsapp accounts"
  ON whatsapp_business_accounts
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM team_members
      WHERE team_members.id = auth.uid()
    )
  );

CREATE POLICY "Team members can update whatsapp accounts"
  ON whatsapp_business_accounts
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM team_members
      WHERE team_members.id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM team_members
      WHERE team_members.id = auth.uid()
    )
  );

CREATE POLICY "Team members can delete whatsapp accounts"
  ON whatsapp_business_accounts
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM team_members
      WHERE team_members.id = auth.uid()
    )
  );

CREATE INDEX IF NOT EXISTS idx_whatsapp_business_accounts_status
  ON whatsapp_business_accounts(status);

CREATE INDEX IF NOT EXISTS idx_whatsapp_business_accounts_waba_id
  ON whatsapp_business_accounts(waba_id);
