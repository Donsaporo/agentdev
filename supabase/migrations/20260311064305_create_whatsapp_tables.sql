/*
  # Create WhatsApp Sales Agent Tables

  1. New Tables
    - `whatsapp_contacts`
      - `id` (uuid, primary key)
      - `wa_id` (text, unique) - WhatsApp ID / phone number
      - `phone_number` (text) - formatted phone number
      - `display_name` (text) - custom display name
      - `profile_name` (text) - WhatsApp profile name
      - `lead_status` (text) - sales funnel status: new, contacted, qualified, proposal_sent, won, lost
      - `notes` (text) - internal notes
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)

    - `whatsapp_conversations`
      - `id` (uuid, primary key)
      - `contact_id` (uuid, FK to whatsapp_contacts)
      - `status` (text) - active, closed, archived
      - `last_message_at` (timestamptz)
      - `unread_count` (integer)
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)

    - `whatsapp_messages`
      - `id` (uuid, primary key)
      - `conversation_id` (uuid, FK to whatsapp_conversations)
      - `contact_id` (uuid, FK to whatsapp_contacts)
      - `wa_message_id` (text) - Meta's unique message ID
      - `direction` (text) - inbound or outbound
      - `message_type` (text) - text, image, audio, video, document, location, interactive, template
      - `content` (text) - message body text
      - `media_url` (text) - media ID or URL
      - `media_mime_type` (text) - MIME type for media
      - `metadata` (jsonb) - full raw payload and extra data
      - `status` (text) - sent, delivered, read, failed, received
      - `created_at` (timestamptz)

  2. Security
    - RLS enabled on all tables
    - Authenticated team members can read all WhatsApp data
    - Authenticated team members can insert/update messages and contacts
    - Edge Function uses service_role_key to bypass RLS for webhook writes

  3. Indexes
    - whatsapp_contacts: wa_id (unique), lead_status
    - whatsapp_conversations: contact_id, status, last_message_at
    - whatsapp_messages: conversation_id, wa_message_id, direction, created_at
*/

-- WhatsApp Contacts
CREATE TABLE IF NOT EXISTS whatsapp_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wa_id text UNIQUE NOT NULL,
  phone_number text NOT NULL DEFAULT '',
  display_name text NOT NULL DEFAULT '',
  profile_name text NOT NULL DEFAULT '',
  lead_status text NOT NULL DEFAULT 'new',
  notes text NOT NULL DEFAULT '',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE whatsapp_contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Team members can view all contacts"
  ON whatsapp_contacts FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM team_members WHERE team_members.id = auth.uid()
    )
  );

CREATE POLICY "Team members can insert contacts"
  ON whatsapp_contacts FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM team_members WHERE team_members.id = auth.uid()
    )
  );

CREATE POLICY "Team members can update contacts"
  ON whatsapp_contacts FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM team_members WHERE team_members.id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM team_members WHERE team_members.id = auth.uid()
    )
  );

CREATE INDEX IF NOT EXISTS idx_whatsapp_contacts_lead_status ON whatsapp_contacts(lead_status);

-- WhatsApp Conversations
CREATE TABLE IF NOT EXISTS whatsapp_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES whatsapp_contacts(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active',
  last_message_at timestamptz DEFAULT now(),
  unread_count integer NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE whatsapp_conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Team members can view all conversations"
  ON whatsapp_conversations FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM team_members WHERE team_members.id = auth.uid()
    )
  );

CREATE POLICY "Team members can insert conversations"
  ON whatsapp_conversations FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM team_members WHERE team_members.id = auth.uid()
    )
  );

CREATE POLICY "Team members can update conversations"
  ON whatsapp_conversations FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM team_members WHERE team_members.id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM team_members WHERE team_members.id = auth.uid()
    )
  );

CREATE INDEX IF NOT EXISTS idx_whatsapp_conversations_contact ON whatsapp_conversations(contact_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_conversations_status ON whatsapp_conversations(status);
CREATE INDEX IF NOT EXISTS idx_whatsapp_conversations_last_msg ON whatsapp_conversations(last_message_at DESC);

-- WhatsApp Messages
CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES whatsapp_conversations(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES whatsapp_contacts(id) ON DELETE CASCADE,
  wa_message_id text NOT NULL DEFAULT '',
  direction text NOT NULL DEFAULT 'inbound',
  message_type text NOT NULL DEFAULT 'text',
  content text NOT NULL DEFAULT '',
  media_url text NOT NULL DEFAULT '',
  media_mime_type text NOT NULL DEFAULT '',
  metadata jsonb DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'received',
  created_at timestamptz DEFAULT now()
);

ALTER TABLE whatsapp_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Team members can view all messages"
  ON whatsapp_messages FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM team_members WHERE team_members.id = auth.uid()
    )
  );

CREATE POLICY "Team members can insert messages"
  ON whatsapp_messages FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM team_members WHERE team_members.id = auth.uid()
    )
  );

CREATE POLICY "Team members can update messages"
  ON whatsapp_messages FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM team_members WHERE team_members.id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM team_members WHERE team_members.id = auth.uid()
    )
  );

CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_conversation ON whatsapp_messages(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_wa_id ON whatsapp_messages(wa_message_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_direction ON whatsapp_messages(direction);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_contact ON whatsapp_messages(contact_id);
