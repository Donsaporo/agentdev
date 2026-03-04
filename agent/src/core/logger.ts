import { getSupabase } from './supabase.js';

type Severity = 'info' | 'warning' | 'error' | 'success';

const COLORS: Record<Severity, string> = {
  info: '\x1b[36m',
  warning: '\x1b[33m',
  error: '\x1b[31m',
  success: '\x1b[32m',
};
const RESET = '\x1b[0m';

export async function log(
  action: string,
  category: string,
  severity: Severity,
  projectId?: string | null,
  details?: Record<string, unknown>
): Promise<void> {
  const timestamp = new Date().toISOString();
  const color = COLORS[severity];
  const prefix = projectId ? `[${projectId.slice(0, 8)}]` : '[system]';
  console.log(`${color}${timestamp} ${severity.toUpperCase()} ${prefix} ${action}${RESET}`);

  try {
    const supabase = getSupabase();
    await supabase.from('agent_logs').insert({
      project_id: projectId || null,
      action,
      category,
      severity,
      details: details || {},
    });
  } catch (err) {
    console.error('Failed to write agent log to DB:', err);
  }
}

export const logger = {
  info: (action: string, category: string, projectId?: string | null, details?: Record<string, unknown>) =>
    log(action, category, 'info', projectId, details),
  warn: (action: string, category: string, projectId?: string | null, details?: Record<string, unknown>) =>
    log(action, category, 'warning', projectId, details),
  error: (action: string, category: string, projectId?: string | null, details?: Record<string, unknown>) =>
    log(action, category, 'error', projectId, details),
  success: (action: string, category: string, projectId?: string | null, details?: Record<string, unknown>) =>
    log(action, category, 'success', projectId, details),
};
