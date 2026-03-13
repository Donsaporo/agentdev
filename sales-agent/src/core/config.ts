import 'dotenv/config';

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback = ''): string {
  return process.env[key] || fallback;
}

export const config = {
  supabase: {
    url: required('SUPABASE_URL'),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  },
  crm: {
    url: optional('CRM_SUPABASE_URL'),
    serviceRoleKey: optional('CRM_SUPABASE_SERVICE_ROLE_KEY'),
  },
  anthropic: {
    apiKey: required('ANTHROPIC_API_KEY'),
    model: optional('ANTHROPIC_MODEL', 'claude-sonnet-4-20250514'),
    maxTokens: parseInt(optional('ANTHROPIC_MAX_TOKENS', '1024'), 10),
  },
  d360: {
    apiKey: required('D360_API_KEY'),
    channelId: optional('D360_CHANNEL_ID'),
    baseUrl: optional('D360_BASE_URL', 'https://waba-v2.360dialog.io'),
  },
  google: {
    clientId: optional('GOOGLE_CLIENT_ID'),
    clientSecret: optional('GOOGLE_CLIENT_SECRET'),
    refreshToken: optional('GOOGLE_REFRESH_TOKEN'),
    calendarId: optional('GOOGLE_CALENDAR_ID', 'primary'),
  },
  recall: {
    apiKey: optional('RECALL_API_KEY'),
    webhookSecret: optional('RECALL_WEBHOOK_SECRET'),
  },
  escalation: {
    emailTo: optional('ESCALATION_EMAIL', 'sales@obzide.com'),
    supabaseUrl: optional('SUPABASE_URL'),
    supabaseAnonKey: optional('SUPABASE_ANON_KEY'),
  },
  director: {
    phones: optional('DIRECTOR_PHONES', '').split(',').map(p => p.trim()).filter(Boolean),
  },
  agent: {
    heartbeatInterval: 60_000,
    minResponseDelay: 4_000,
    maxResponseDelay: 25_000,
    messageBatchWindow: 10_000,
    messageBatchExtraDelay: 5_000,
  },
} as const;
