/*
  # Add Brief Attachments Infrastructure

  1. New Tables
    - `brief_attachments`
      - `id` (uuid, primary key)
      - `brief_id` (uuid, FK to briefs)
      - `file_name` (text)
      - `file_url` (text)
      - `file_type` (text) - mime type
      - `file_size` (integer) - bytes
      - `processing_status` (text) - pending/processed/failed
      - `extracted_content` (text) - text extracted from PDFs/images
      - `created_at` (timestamptz)

  2. Storage
    - Create `brief-attachments` bucket for uploaded files

  3. Security
    - Enable RLS on brief_attachments
    - Policy for authenticated team members to manage attachments
*/

CREATE TABLE IF NOT EXISTS public.brief_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brief_id uuid REFERENCES public.briefs(id) ON DELETE CASCADE NOT NULL,
  file_name text NOT NULL DEFAULT '',
  file_url text NOT NULL DEFAULT '',
  file_type text NOT NULL DEFAULT '',
  file_size integer NOT NULL DEFAULT 0,
  processing_status text NOT NULL DEFAULT 'pending',
  extracted_content text NOT NULL DEFAULT '',
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.brief_attachments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Team members can view brief attachments"
  ON public.brief_attachments FOR SELECT
  TO authenticated
  USING (public.is_team_member());

CREATE POLICY "Team members can insert brief attachments"
  ON public.brief_attachments FOR INSERT
  TO authenticated
  WITH CHECK (public.is_team_member());

CREATE POLICY "Team members can update brief attachments"
  ON public.brief_attachments FOR UPDATE
  TO authenticated
  USING (public.is_team_member())
  WITH CHECK (public.is_team_member());

CREATE POLICY "Team members can delete brief attachments"
  ON public.brief_attachments FOR DELETE
  TO authenticated
  USING (public.is_team_member());

CREATE INDEX IF NOT EXISTS idx_brief_attachments_brief_id ON public.brief_attachments(brief_id);

INSERT INTO storage.buckets (id, name, public) VALUES ('brief-attachments', 'brief-attachments', true) ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Anyone can read brief attachments storage"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'brief-attachments');

CREATE POLICY "Authenticated can upload brief attachments storage"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'brief-attachments');

CREATE POLICY "Authenticated can delete brief attachments storage"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'brief-attachments');
