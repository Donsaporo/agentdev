import { createClient, SupabaseClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { config } from './config.js';

let mainClient: SupabaseClient | null = null;
let crmClient: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!mainClient) {
    mainClient = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: {
        transport: WebSocket as unknown as new (url: string | URL, protocols?: string | string[]) => globalThis.WebSocket,
        params: {
          apikey: config.supabase.serviceRoleKey,
          eventsPerSecond: 10,
        },
        timeout: 30_000,
      },
    });
  }
  return mainClient;
}

export function getCrmSupabase(): SupabaseClient | null {
  if (!config.crm.url || !config.crm.serviceRoleKey) return null;
  if (!crmClient) {
    crmClient = createClient(config.crm.url, config.crm.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return crmClient;
}
