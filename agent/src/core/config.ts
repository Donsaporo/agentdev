import { getSupabase } from './supabase.js';
import type { AgentConfig } from './types.js';

const DEFAULTS: AgentConfig = {
  default_model: 'claude-sonnet-4-20250514',
  auto_deploy: false,
  max_corrections: 3,
  auto_qa: true,
  notification_email: 'team@obzide.com',
  supabase_org_id: '',
  supabase_db_region: 'us-east-1',
};

let cached: AgentConfig | null = null;
let lastFetch = 0;
const CACHE_TTL = 30_000;

export async function getConfig(): Promise<AgentConfig> {
  const now = Date.now();
  if (cached && now - lastFetch < CACHE_TTL) return cached;

  const supabase = getSupabase();
  const { data, error } = await supabase.from('agent_config').select('key, value');

  if (error || !data) {
    console.error('Failed to load agent config, using defaults:', error);
    return DEFAULTS;
  }

  const config = { ...DEFAULTS };
  for (const row of data) {
    const key = row.key as keyof AgentConfig;
    if (key in config) {
      const raw = row.value;
      const defaultVal = DEFAULTS[key];
      if (typeof defaultVal === 'boolean') {
        (config as Record<string, unknown>)[key] = raw === true || raw === 'true';
      } else if (typeof defaultVal === 'number') {
        const num = Number(raw);
        (config as Record<string, unknown>)[key] = Number.isFinite(num) ? num : defaultVal;
      } else {
        (config as Record<string, unknown>)[key] = raw;
      }
    }
  }

  cached = config;
  lastFetch = now;
  return config;
}

export function invalidateConfigCache(): void {
  cached = null;
  lastFetch = 0;
}
