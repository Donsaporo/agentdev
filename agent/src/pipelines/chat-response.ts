import { getSupabase } from '../core/supabase.js';
import { logger } from '../core/logger.js';
import { generateChatResponse } from '../services/claude.js';
import { pushFiles } from '../services/github.js';
import { triggerDeployment, waitForDeployment } from '../services/vercel.js';
import { captureAllPages } from '../services/screenshots.js';
import { getConfig } from '../core/config.js';

async function sendReply(conversationId: string, content: string): Promise<void> {
  const supabase = getSupabase();
  await supabase.from('agent_messages').insert({
    conversation_id: conversationId,
    role: 'assistant',
    content,
    metadata: {},
  });
}

function extractRepoFullName(gitRepoUrl: string): string | null {
  const match = gitRepoUrl.match(/github\.com\/(.+?)(?:\.git)?$/);
  return match ? match[1] : null;
}

export async function handleChatMessage(
  projectId: string,
  conversationId: string,
  messageContent: string
): Promise<void> {
  const supabase = getSupabase();

  let previousStatus: string | null = null;
  try {
    const { data: currentProject } = await supabase
      .from('projects')
      .select('agent_status')
      .eq('id', projectId)
      .maybeSingle();
    previousStatus = currentProject?.agent_status || null;

    const isPipelineRunning = previousStatus === 'working';
    if (!isPipelineRunning) {
      await supabase.from('projects').update({ agent_status: 'working' }).eq('id', projectId);
    }

    const { data: project } = await supabase
      .from('projects')
      .select('*, clients(*)')
      .eq('id', projectId)
      .maybeSingle();
    if (!project) throw new Error(`Project ${projectId} not found`);

    const { data: brief } = await supabase
      .from('briefs')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const { data: recentTasks } = await supabase
      .from('project_tasks')
      .select('title, status, error_log')
      .eq('project_id', projectId)
      .order('order_index', { ascending: true })
      .limit(20);

    const { data: recentLogs } = await supabase
      .from('agent_logs')
      .select('action, category, severity, created_at')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(10);

    const { data: messages } = await supabase
      .from('agent_messages')
      .select('role, content, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(20);

    const projectContext = [
      `PROJECT: ${project.name} (${project.type})`,
      `CLIENT: ${project.clients?.name || 'Unknown'}`,
      `STATUS: ${project.status} | PHASE: ${project.current_phase}`,
      `DEMO: ${project.demo_url || 'Not deployed'}`,
      `REPO: ${project.git_repo_url || 'Not created'}`,
      brief ? `\nBRIEF: ${brief.original_content}` : '',
      brief?.architecture_plan ? `\nARCHITECTURE: ${JSON.stringify(brief.architecture_plan, null, 2)}` : '',
      recentTasks?.length ? `\nTASKS:\n${recentTasks.map((t) => `- [${t.status}] ${t.title}`).join('\n')}` : '',
      recentLogs?.length ? `\nRECENT ACTIVITY:\n${recentLogs.map((l) => `- [${l.severity}] ${l.action}`).join('\n')}` : '',
    ].filter(Boolean).join('\n');

    const chatHistory = (messages || [])
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const result = await generateChatResponse(chatHistory, projectContext);

    if (result.files.length > 0 && project.git_repo_url) {
      const repoFullName = extractRepoFullName(project.git_repo_url);
      if (repoFullName) {
        await pushFiles(repoFullName, result.files, `chat: ${messageContent.slice(0, 50)}`, projectId);
        await sendReply(conversationId, result.response + '\n\nCode changes pushed to the repository.');

        if (result.shouldRedeploy && project.vercel_project_id) {
          await sendReply(conversationId, 'Redeploying with changes...');
          const deployment = await triggerDeployment(
            project.git_repo_url.split('/').pop()?.replace('.git', '') || project.name,
            projectId
          );
          const deployResult = await waitForDeployment(deployment.deploymentId, projectId);

          if (deployResult.status === 'ready') {
            await supabase.from('projects').update({ demo_url: deployResult.url }).eq('id', projectId);
            await sendReply(conversationId, `Redeployed: ${deployResult.url}`);

            const config = await getConfig();
            if (config.auto_qa) {
              const arch = brief?.architecture_plan as { pages?: { name: string; route: string }[] } | undefined;
              const pages = arch?.pages || [{ name: 'Home', route: '/' }];
              const currentVersion = await getCurrentQAVersion(projectId);
              const screenshots = await captureAllPages(deployResult.url, pages, projectId, currentVersion + 1);

              for (const ss of screenshots) {
                await supabase.from('qa_screenshots').insert({
                  project_id: projectId,
                  page_name: ss.pageName,
                  page_url: ss.pageUrl,
                  desktop_url: ss.desktopUrl,
                  tablet_url: ss.tabletUrl,
                  mobile_url: ss.mobileUrl,
                  status: 'pending',
                  version_number: currentVersion + 1,
                });
              }
              await sendReply(conversationId, 'Fresh QA screenshots captured.');
            }
          } else {
            await sendReply(conversationId, `Deployment failed: ${deployResult.buildLogs || 'Unknown error'}`);
          }
        }
      } else {
        await sendReply(conversationId, result.response);
      }
    } else {
      await sendReply(conversationId, result.response);
    }

    if (previousStatus !== 'working') {
      await supabase.from('projects').update({ agent_status: 'idle' }).eq('id', projectId);
    }
    await logger.info('Chat response sent', 'chat', projectId);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await logger.error(`Chat response failed: ${errMsg}`, 'chat', projectId);
    await sendReply(conversationId, `Sorry, I encountered an error: ${errMsg}`);
    if (previousStatus !== 'working') {
      await supabase.from('projects').update({ agent_status: 'idle' }).eq('id', projectId);
    }
  }
}

async function getCurrentQAVersion(projectId: string): Promise<number> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from('qa_screenshots')
    .select('version_number')
    .eq('project_id', projectId)
    .order('version_number', { ascending: false })
    .limit(1)
    .maybeSingle();

  return data?.version_number || 0;
}
