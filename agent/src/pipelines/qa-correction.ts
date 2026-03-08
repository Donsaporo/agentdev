import { getSupabase } from '../core/supabase.js';
import { logger } from '../core/logger.js';
import { getConfig } from '../core/config.js';
import { analyzeQARejection, analyzeScreenshotAllViewports } from '../services/claude.js';
import { pushFiles, getMultipleFileContents, getRepoTree } from '../services/github.js';
import { triggerDeployment, waitForDeployment } from '../services/vercel.js';
import { capturePageScreenshots } from '../services/screenshots.js';

function extractRepoFullName(gitRepoUrl: string): string | null {
  const match = gitRepoUrl.match(/github\.com\/(.+?)(?:\.git)?$/);
  return match ? match[1] : null;
}

async function sendChatMessage(projectId: string, content: string): Promise<void> {
  const supabase = getSupabase();
  const { data: conv } = await supabase
    .from('agent_conversations')
    .select('id')
    .eq('project_id', projectId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (conv) {
    await supabase.from('agent_messages').insert({
      conversation_id: conv.id,
      role: 'assistant',
      content,
      metadata: {},
    });
  }
}

export async function handleQARejection(
  projectId: string,
  screenshotId: string,
  pageName: string,
  rejectionNotes: string
): Promise<void> {
  const supabase = getSupabase();
  const config = await getConfig();

  let isPipelineRunning = false;
  try {
    const { data: currentProject } = await supabase
      .from('projects')
      .select('agent_status')
      .eq('id', projectId)
      .maybeSingle();
    isPipelineRunning = currentProject?.agent_status === 'working';

    if (!isPipelineRunning) {
      await supabase.from('projects').update({ agent_status: 'working' }).eq('id', projectId);
    }
    await sendChatMessage(projectId, `Working on QA fix for "${pageName}": ${rejectionNotes}`);

    const { data: screenshot } = await supabase
      .from('qa_screenshots')
      .select('*')
      .eq('id', screenshotId)
      .maybeSingle();
    if (!screenshot) throw new Error(`Screenshot ${screenshotId} not found`);

    if (screenshot.version_number >= config.max_corrections) {
      await supabase.from('projects').update({ agent_status: 'waiting' }).eq('id', projectId);
      await sendChatMessage(
        projectId,
        `I've reached the maximum number of auto-corrections (${config.max_corrections}) for "${pageName}". Please review manually or provide more specific feedback.`
      );
      await logger.warn(`Max corrections reached for ${pageName}`, 'qa', projectId);
      return;
    }

    const { data: project } = await supabase
      .from('projects')
      .select('*, clients(*)')
      .eq('id', projectId)
      .maybeSingle();
    if (!project) throw new Error(`Project ${projectId} not found`);

    const { data: brief } = await supabase
      .from('briefs')
      .select('original_content, architecture_plan')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const repoFullName = extractRepoFullName(project.git_repo_url);
    if (!repoFullName) throw new Error('No repo URL found');

    const allFiles = await getRepoTree(repoFullName);
    const codeFilePaths = allFiles
      .filter((f) => f.type === 'file' && /\.(tsx?|jsx?|css)$/.test(f.path))
      .map((f) => f.path);

    const pageSlug = pageName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const relevantPaths = codeFilePaths.filter(
      (p) => p.toLowerCase().includes(pageSlug) || p.includes('layout') || p.includes('App')
    );

    const currentCode = await getMultipleFileContents(repoFullName, relevantPaths.slice(0, 15));
    const briefContext = brief ? `${brief.original_content}\n\nArchitecture: ${JSON.stringify(brief.architecture_plan)}` : '';

    const result = await analyzeQARejection(rejectionNotes, pageName, currentCode, briefContext, {
      desktop: screenshot.desktop_url,
      tablet: screenshot.tablet_url,
      mobile: screenshot.mobile_url,
    });

    if (result.files.length === 0) {
      await sendChatMessage(projectId, `I couldn't determine what changes to make for "${pageName}". Please provide more specific feedback.`);
      await supabase.from('projects').update({ agent_status: 'idle' }).eq('id', projectId);
      return;
    }

    await pushFiles(repoFullName, result.files, `fix: QA correction for ${pageName} - ${rejectionNotes.slice(0, 50)}`, projectId);
    await sendChatMessage(projectId, `Code fixes applied for "${pageName}". Redeploying...`);

    if (project.vercel_project_id) {
      const repoName = repoFullName.split('/').pop() || project.name;
      const deployment = await triggerDeployment(repoName, projectId);
      const deployResult = await waitForDeployment(deployment.deploymentId, projectId);

      if (deployResult.status === 'ready') {
        const newVersion = screenshot.version_number + 1;
        const pageUrl = screenshot.page_url || `${deployResult.url}/`;

        const screenshotResult = await capturePageScreenshots(
          pageUrl,
          pageName,
          projectId,
          newVersion
        );

        await supabase.from('qa_screenshots').insert({
          project_id: projectId,
          task_id: screenshot.task_id,
          page_name: pageName,
          page_url: pageUrl,
          desktop_url: screenshotResult.desktopUrl,
          tablet_url: screenshotResult.tabletUrl,
          mobile_url: screenshotResult.mobileUrl,
          status: 'pending',
          version_number: newVersion,
        });

        await supabase.from('projects').update({ demo_url: deployResult.url }).eq('id', projectId);
        await sendChatMessage(projectId, `Fix deployed and new screenshots (v${newVersion}) captured for "${pageName}". Please review.`);
      } else {
        await sendChatMessage(projectId, `Deployment failed after QA fix: ${deployResult.buildLogs || 'Unknown error'}`);
      }
    }

    if (!isPipelineRunning) {
      await supabase.from('projects').update({ agent_status: 'idle' }).eq('id', projectId);
    }
    await logger.success(`QA correction complete for ${pageName}`, 'qa', projectId);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await logger.error(`QA correction failed: ${errMsg}`, 'qa', projectId);
    await sendChatMessage(projectId, `QA correction failed: ${errMsg}`);
    if (!isPipelineRunning) {
      await supabase.from('projects').update({ agent_status: 'idle', last_error_message: errMsg }).eq('id', projectId);
    }
  }
}
