import { getSupabase } from './supabase.js';
import { logger } from './logger.js';

interface SecretEntry {
  service_name: string;
  secret_value: string;
  status: string;
}

let cache: Map<string, string> = new Map();
let lastFetch = 0;
const CACHE_TTL = 60_000;

export async function loadSecrets(): Promise<Map<string, string>> {
  const now = Date.now();
  if (cache.size > 0 && now - lastFetch < CACHE_TTL) return cache;

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('agent_secrets')
    .select('service_name, secret_value, status');

  if (error || !data) {
    if (cache.size > 0) return cache;
    await logger.warn('Failed to load secrets from Supabase, falling back to env vars', 'system');
    return cache;
  }

  const newCache = new Map<string, string>();
  for (const row of data as SecretEntry[]) {
    if (row.secret_value && row.secret_value.length > 0) {
      newCache.set(row.service_name, row.secret_value);
    }
  }

  cache = newCache;
  lastFetch = now;
  return cache;
}

export async function getSecret(serviceName: string): Promise<string> {
  const secrets = await loadSecrets();
  return secrets.get(serviceName) || '';
}

export function invalidateSecretsCache(): void {
  cache = new Map();
  lastFetch = 0;
}

const ENV_FALLBACKS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  github: 'GITHUB_TOKEN',
  github_org: 'GITHUB_ORG',
  vercel: 'VERCEL_TOKEN',
  vercel_team_id: 'VERCEL_TEAM_ID',
  namecheap: 'NAMECHEAP_API_KEY',
  namecheap_user: 'NAMECHEAP_API_USER',
  resend: 'RESEND_API_KEY',
  brave: 'BRAVE_API_KEY',
  supabase_management: 'SUPABASE_MANAGEMENT_TOKEN',
  supabase_org_id: 'SUPABASE_ORG_ID',
  browserless: 'BROWSERLESS_API_KEY',
};

export async function getSecretWithFallback(serviceName: string): Promise<string> {
  const fromDb = await getSecret(serviceName);
  if (fromDb) return fromDb;

  const envVar = ENV_FALLBACKS[serviceName];
  if (envVar && process.env[envVar]) {
    return process.env[envVar]!;
  }

  return '';
}

export async function updateSecretStatus(
  serviceName: string,
  status: 'connected' | 'error' | 'untested',
  message: string = ''
): Promise<void> {
  const supabase = getSupabase();
  await supabase
    .from('agent_secrets')
    .update({
      status,
      status_message: message,
      last_tested: new Date().toISOString(),
    })
    .eq('service_name', serviceName);
}
