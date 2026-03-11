import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from './config.js';

let mainClient: SupabaseClient | null = null;
let crmClient: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!mainClient) {
    mainClient = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
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
