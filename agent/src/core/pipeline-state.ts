import { getSupabase } from './supabase.js';
import { logger } from './logger.js';
import type { PipelineState } from './types.js';

export async function saveCheckpoint(
  projectId: string,
  briefId: string,
  phase: string,
  phaseData: Record<string, unknown>,
  modulesCompleted: string[],
  repoFullName: string
): Promise<void> {
  const supabase = getSupabase();

  const { data: existing } = await supabase
    .from('pipeline_state')
    .select('id')
    .eq('project_id', projectId)
    .maybeSingle();

  const row = {
    project_id: projectId,
    brief_id: briefId,
    current_phase: phase,
    phase_data: phaseData,
    modules_completed: modulesCompleted,
    repo_full_name: repoFullName,
    last_checkpoint: new Date().toISOString(),
    status: 'running' as const,
  };

  if (existing) {
    await supabase.from('pipeline_state').update(row).eq('id', existing.id);
  } else {
    await supabase.from('pipeline_state').insert(row);
  }
}

export async function getCheckpoint(projectId: string): Promise<PipelineState | null> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from('pipeline_state')
    .select('*')
    .eq('project_id', projectId)
    .eq('status', 'running')
    .maybeSingle();

  return data as PipelineState | null;
}

export async function clearCheckpoint(projectId: string, status: 'completed' | 'failed' = 'completed'): Promise<void> {
  const supabase = getSupabase();
  await supabase
    .from('pipeline_state')
    .update({ status, last_checkpoint: new Date().toISOString() })
    .eq('project_id', projectId);
}

export async function recordDeployment(
  projectId: string,
  vercelDeploymentId: string,
  commitSha: string,
  url: string,
  status: string,
  durationSeconds: number,
  triggeredBy: string,
  buildLogs: string = ''
): Promise<void> {
  const supabase = getSupabase();

  try {
    await supabase.from('deployments').insert({
      project_id: projectId,
      vercel_deployment_id: vercelDeploymentId,
      commit_sha: commitSha,
      url,
      status,
      build_duration_seconds: durationSeconds,
      triggered_by: triggeredBy,
      build_logs: buildLogs.slice(0, 10000),
    });
  } catch (err) {
    await logger.warn(
      `Failed to record deployment: ${err instanceof Error ? err.message : String(err)}`,
      'deployment',
      projectId
    );
  }
}
