import { supabase } from './supabase';

interface CaptureRequest {
  project_id: string;
  pages: { name: string; url: string }[];
}

interface ScreenshotResultItem {
  page_name: string;
  screenshot_id: string;
  desktop_url: string;
  tablet_url: string;
  mobile_url: string;
  version: number;
}

interface CaptureResponse {
  results: ScreenshotResultItem[];
}

export async function triggerScreenshots(
  projectId: string,
  pages: { name: string; url: string }[]
): Promise<{ data: CaptureResponse | null; error: string | null }> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { data: null, error: 'Not authenticated' };

  const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/capture-screenshots`;

  const body: CaptureRequest = { project_id: projectId, pages };

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
      'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({ error: 'Unknown error' }));
    return { data: null, error: errData.error || `HTTP ${response.status}` };
  }

  const data: CaptureResponse = await response.json();
  return { data, error: null };
}
