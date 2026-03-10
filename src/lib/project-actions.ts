import { supabase } from './supabase';

interface DeleteResult {
  service: string;
  success: boolean;
  message: string;
}

interface DeleteResponse {
  results: DeleteResult[];
  error?: string;
}

export async function deleteProjectFull(
  projectId: string
): Promise<{ data: DeleteResponse | null; error: string | null }> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { data: null, error: 'Not authenticated' };

  const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/delete-project`;

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
      'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ project_id: projectId }),
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({ error: 'Unknown error' }));
    return { data: null, error: errData.error || `HTTP ${response.status}` };
  }

  const data: DeleteResponse = await response.json();
  return { data, error: data.error || null };
}
