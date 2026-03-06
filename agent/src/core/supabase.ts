import { createClient, SupabaseClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { env } from './env.js';

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!client) {
    client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: {
        transport: WebSocket as unknown as new (url: string | URL, protocols?: string | string[]) => globalThis.WebSocket,
      },
    });
  }
  return client;
}
