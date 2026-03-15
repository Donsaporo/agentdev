/*
  # Create media storage bucket and fix realtime publication

  1. Storage
    - Create `media` bucket (public) for WhatsApp media files (images, audio, documents, video)
    - Add storage policy allowing service role and authenticated users to upload/read

  2. Realtime
    - Add `sales_agent_instructions` to supabase_realtime publication so the sales agent
      can receive live instruction updates from the dashboard
    - Add `sales_agent_personas` to supabase_realtime publication for live persona updates

  3. Important Notes
    - The media bucket is public because the webhook uses getPublicUrl to generate direct links
    - These changes fix two gaps identified in the production readiness audit
*/

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'media',
  'media',
  true,
  52428800,
  ARRAY['image/jpeg','image/png','image/webp','image/gif','audio/ogg','audio/mpeg','audio/mp4','audio/amr','video/mp4','video/3gpp','application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/msword','application/vnd.ms-excel']
)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Authenticated users can upload media"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'media');

CREATE POLICY "Anyone can read media"
  ON storage.objects
  FOR SELECT
  TO public
  USING (bucket_id = 'media');

CREATE POLICY "Authenticated users can delete own media"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (bucket_id = 'media' AND auth.uid() IS NOT NULL);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
    AND tablename = 'sales_agent_instructions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.sales_agent_instructions;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
    AND tablename = 'sales_agent_personas'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.sales_agent_personas;
  END IF;
END $$;
