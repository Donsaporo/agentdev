function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export const env = {
  get SUPABASE_URL() { return required('SUPABASE_URL'); },
  get SUPABASE_SERVICE_ROLE_KEY() { return required('SUPABASE_SERVICE_ROLE_KEY'); },
  get ANTHROPIC_API_KEY() { return required('ANTHROPIC_API_KEY'); },
  get GITHUB_TOKEN() { return required('GITHUB_TOKEN'); },
  get GITHUB_ORG() { return optional('GITHUB_ORG', 'obzide-tech'); },
  get VERCEL_TOKEN() { return required('VERCEL_TOKEN'); },
  get VERCEL_TEAM_ID() { return optional('VERCEL_TEAM_ID', ''); },
  get NAMECHEAP_API_USER() { return optional('NAMECHEAP_API_USER', ''); },
  get NAMECHEAP_API_KEY() { return optional('NAMECHEAP_API_KEY', ''); },
  get NAMECHEAP_CLIENT_IP() { return optional('NAMECHEAP_CLIENT_IP', '178.156.252.99'); },
  get RESEND_API_KEY() { return optional('RESEND_API_KEY', ''); },
  get NODE_ENV() { return optional('NODE_ENV', 'production'); },
};
