import { getSupabase } from '../core/supabase.js';
import { logger } from '../core/logger.js';
import { getConfig } from '../core/config.js';
import { analyzeBrief, generateProjectScaffold, generateTaskCode } from '../services/claude.js';
import { createRepo, pushFiles, getMultipleFileContents, getRepoFiles } from '../services/github.js';
import { createProject as createVercelProject, triggerDeployment, waitForDeployment } from '../services/vercel.js';
import { captureAllPages } from '../services/screenshots.js';
import { notifyBuildComplete, notifyQAReady, notifyError } from '../services/notifications.js';
import type { Brief, Client, Project } from '../core/types.js';

async function updateProject(
  projectId: string,
  updates: Record<string, unknown>
): Promise<void> {
  const supabase = getSupabase();
  await supabase.from('projects').update(updates).eq('id', projectId);
}

async function sendChatMessage(
  projectId: string,
  content: string
): Promise<void> {
  const supabase = getSupabase();
  const { data: conv } = await supabase
    .from('agent_conversations')
    .select('id')
    .eq('project_id', projectId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  let conversationId = conv?.id;
  if (!conversationId) {
    const { data: newConv } = await supabase
      .from('agent_conversations')
      .insert({ project_id: projectId, title: 'Build Log' })
      .select('id')
      .maybeSingle();
    conversationId = newConv?.id;
  }

  if (conversationId) {
    await supabase.from('agent_messages').insert({
      conversation_id: conversationId,
      role: 'assistant',
      content,
      metadata: {},
    });
  }
}

export async function processBrief(projectId: string, briefId: string): Promise<void> {
  const supabase = getSupabase();

  try {
    await updateProject(projectId, { agent_status: 'working', current_phase: 'analysis', status: 'in_progress' });
    await sendChatMessage(projectId, 'Starting to process your brief. Analyzing requirements...');

    const { data: brief } = await supabase.from('briefs').select('*').eq('id', briefId).maybeSingle();
    if (!brief) throw new Error(`Brief ${briefId} not found`);

    const { data: project } = await supabase
      .from('projects')
      .select('*, clients(*)')
      .eq('id', projectId)
      .maybeSingle();
    if (!project) throw new Error(`Project ${projectId} not found`);

    const client = project.clients as Client;

    // Phase 1: Analysis
    await logger.info('Phase 1: Analyzing brief', 'development', projectId);
    const analysis = await analyzeBrief(brief as Brief, client, project as unknown as Project);

    if (analysis.questions.length > 0) {
      await supabase.from('briefs').update({
        parsed_requirements: analysis.requirements,
        architecture_plan: analysis.architecture,
        questions: analysis.questions.map((q, i) => ({
          id: `q-${i}`,
          question: q.question,
          category: q.category,
          answered: false,
        })),
        status: 'questions_pending',
      }).eq('id', briefId);

      await updateProject(projectId, { agent_status: 'waiting' });
      const questionList = analysis.questions.map((q) => `- ${q.question}`).join('\n');
      await sendChatMessage(projectId, `I have some questions before I can start building:\n\n${questionList}\n\nPlease answer these in the Brief section and send the brief back to me.`);
      await logger.info('Questions sent to team, waiting for answers', 'development', projectId);
      return;
    }

    await supabase.from('briefs').update({
      parsed_requirements: analysis.requirements,
      architecture_plan: analysis.architecture,
    }).eq('id', briefId);

    await sendChatMessage(projectId, 'Analysis complete. Setting up the repository...');

    // Phase 2: Scaffolding
    await updateProject(projectId, { current_phase: 'scaffolding', progress: 10 });
    await logger.info('Phase 2: Scaffolding project', 'development', projectId);

    const clientSlug = client.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
    const projectSlug = project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
    const repoName = `${clientSlug}-${projectSlug}`;

    const { repoUrl, fullName } = await createRepo(
      repoName,
      `${project.name} - ${client.name} | Built by Obzide Agent`,
      projectId
    );

    await updateProject(projectId, { git_repo_url: repoUrl });

    const scaffold = await generateProjectScaffold(
      project as unknown as Project,
      client,
      analysis.architecture
    );

    if (scaffold.files.length > 0) {
      await pushFiles(fullName, scaffold.files, 'Initial scaffold', projectId);
    }

    await updateProject(projectId, { progress: 25 });
    await sendChatMessage(projectId, `Repository created: ${repoUrl}\nScaffold pushed. Starting page development...`);

    // Phase 3: Development
    await updateProject(projectId, { current_phase: 'development' });
    await logger.info('Phase 3: Developing pages', 'development', projectId);

    const arch = analysis.architecture as { pages?: { name: string; route: string; description: string }[] };
    const pages = arch.pages || [];

    const tasks = [];
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const { data: task } = await supabase.from('project_tasks').insert({
        project_id: projectId,
        title: `Build ${page.name} page`,
        description: page.description || `Implement the ${page.name} page at route ${page.route}`,
        status: 'pending',
        priority: 2,
        order_index: i,
      }).select('id').maybeSingle();
      if (task) tasks.push({ ...task, page });
    }

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const taskStartTime = Date.now();

      await supabase.from('project_tasks').update({
        status: 'in_progress',
        started_at: new Date().toISOString(),
      }).eq('id', task.id);

      await sendChatMessage(projectId, `Building ${task.page.name} page (${i + 1}/${tasks.length})...`);

      try {
        const repoFiles = await getRepoFiles(fullName);
        const codeFiles = repoFiles
          .filter((f) => f.type === 'file' && /\.(tsx?|jsx?|css|json)$/.test(f.path))
          .map((f) => f.path);
        const existingCode = await getMultipleFileContents(fullName, codeFiles.slice(0, 20));

        const codeResult = await generateTaskCode(
          { title: `Build ${task.page.name} page`, description: task.page.description || '' },
          project as unknown as Project,
          client,
          analysis.architecture,
          existingCode
        );

        if (codeResult.files.length > 0) {
          await pushFiles(fullName, codeResult.files, `feat: implement ${task.page.name} page`, projectId);
        }

        const durationSeconds = Math.round((Date.now() - taskStartTime) / 1000);
        await supabase.from('project_tasks').update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          duration_seconds: durationSeconds,
        }).eq('id', task.id);

        const progress = 25 + Math.round(((i + 1) / tasks.length) * 50);
        await updateProject(projectId, { progress });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await supabase.from('project_tasks').update({
          status: 'failed',
          error_log: errMsg,
        }).eq('id', task.id);
        await logger.error(`Task failed: ${task.page.name}: ${errMsg}`, 'development', projectId);
      }
    }

    // Phase 4: Deploy
    await updateProject(projectId, { current_phase: 'deployment', progress: 80 });
    await logger.info('Phase 4: Deploying to Vercel', 'deployment', projectId);
    await sendChatMessage(projectId, 'All pages built. Deploying to Vercel...');

    const vercelProjectId = await createVercelProject(repoName, fullName, projectId);
    await updateProject(projectId, { vercel_project_id: vercelProjectId });

    const deployment = await triggerDeployment(repoName, projectId);
    const result = await waitForDeployment(deployment.deploymentId, projectId);

    if (result.status === 'ready') {
      await updateProject(projectId, { demo_url: result.url, progress: 90 });
      await sendChatMessage(projectId, `Deployed successfully: ${result.url}\nTaking QA screenshots...`);
    } else {
      await updateProject(projectId, { agent_status: 'error' });
      await sendChatMessage(projectId, `Deployment failed: ${result.buildLogs || 'Unknown error'}. Check the logs.`);
      await notifyError(project.name, result.buildLogs || 'Deployment failed', projectId);
      return;
    }

    // Phase 5: QA Screenshots
    const config = await getConfig();
    if (config.auto_qa && result.url) {
      await updateProject(projectId, { current_phase: 'qa' });
      await logger.info('Phase 5: Capturing QA screenshots', 'qa', projectId);

      const screenshotResults = await captureAllPages(
        result.url,
        pages.map((p) => ({ name: p.name, route: p.route })),
        projectId
      );

      for (const ss of screenshotResults) {
        await supabase.from('qa_screenshots').insert({
          project_id: projectId,
          page_name: ss.pageName,
          page_url: ss.pageUrl,
          desktop_url: ss.desktopUrl,
          tablet_url: ss.tabletUrl,
          mobile_url: ss.mobileUrl,
          status: 'pending',
          version_number: 1,
        });
      }

      await updateProject(projectId, { status: 'qa', progress: 100, agent_status: 'idle' });
      await sendChatMessage(projectId, `QA screenshots are ready for review. ${screenshotResults.length} pages captured in 3 viewports each. Check the QA section.`);
      await notifyBuildComplete(project.name, result.url, projectId);
      await notifyQAReady(project.name, screenshotResults.length, projectId);
    } else {
      await updateProject(projectId, { status: 'review', progress: 100, agent_status: 'idle' });
      await sendChatMessage(projectId, 'Build complete. Auto-QA is disabled, project is ready for manual review.');
      await notifyBuildComplete(project.name, result.url, projectId);
    }

    await logger.success('Brief processing pipeline complete', 'development', projectId);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await logger.error(`Brief processing failed: ${errMsg}`, 'development', projectId);
    await updateProject(projectId, { agent_status: 'error' });
    await sendChatMessage(projectId, `An error occurred: ${errMsg}`);

    const { data: project } = await supabase.from('projects').select('name').eq('id', projectId).maybeSingle();
    if (project) await notifyError(project.name, errMsg, projectId);
  }
}
