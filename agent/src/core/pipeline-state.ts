import { getSupabase } from './supabase.js';
import { logger } from './logger.js';
import type { PipelineState } from './types.js';

const STALE_CHECKPOINT_MINUTES = 10;

export async function saveCheckpoint(
  projectId: string,
  briefId: string,
  phase: string,
  phaseData: Record<string, unknown>,
  modulesCompleted: string[],
  repoFullName: string
): Promise<void> {
  const supabase = getSupabase();

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

  const { data: existing } = await supabase
    .from('pipeline_state')
    .select('id, modules_completed')
    .eq('project_id', projectId)
    .maybeSingle();

  if (existing) {
    const merged = Array.from(new Set([
      ...(existing.modules_completed || []),
      ...modulesCompleted,
    ]));
    row.modules_completed = merged;
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

  if (!data) return null;

  const lastCheckpoint = data.last_checkpoint ? new Date(data.last_checkpoint).getTime() : 0;
  const minutesSince = (Date.now() - lastCheckpoint) / (60 * 1000);

  if (minutesSince > STALE_CHECKPOINT_MINUTES) {
    await logger.warn(
      `Checkpoint for project ${projectId} is ${Math.round(minutesSince)}min old (stale threshold: ${STALE_CHECKPOINT_MINUTES}min). Marking as crashed.`,
      'pipeline',
      projectId
    );
    await supabase
      .from('pipeline_state')
      .update({ status: 'failed', last_checkpoint: new Date().toISOString() })
      .eq('id', data.id);
    return null;
  }

  return data as PipelineState | null;
}

export async function clearCheckpoint(projectId: string, status: 'completed' | 'failed' = 'completed'): Promise<void> {
  const supabase = getSupabase();
  await supabase
    .from('pipeline_state')
    .update({ status, last_checkpoint: new Date().toISOString() })
    .eq('project_id', projectId);
}

export async function cleanupStaleCheckpoints(): Promise<void> {
  const supabase = getSupabase();
  const cutoff = new Date(Date.now() - STALE_CHECKPOINT_MINUTES * 60 * 1000).toISOString();

  const { data: stale } = await supabase
    .from('pipeline_state')
    .select('id, project_id')
    .eq('status', 'running')
    .lt('last_checkpoint', cutoff);

  if (stale && stale.length > 0) {
    for (const row of stale) {
      await supabase
        .from('pipeline_state')
        .update({ status: 'failed', last_checkpoint: new Date().toISOString() })
        .eq('id', row.id);
      await logger.warn(`Cleaned up stale checkpoint for project ${row.project_id}`, 'pipeline');
    }
  }
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
