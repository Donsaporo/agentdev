import { getSupabase } from '../core/supabase.js';
import { logger } from '../core/logger.js';
import { getConfig } from '../core/config.js';
import { analyzeBrief, generateProjectScaffold, generateTaskCode, analyzeScreenshotAllViewports } from '../services/claude.js';
import { processAttachments } from '../services/file-processing.js';
import { researchReferenceUrls } from '../services/web-research.js';
import { createRepo, pushFiles, getMultipleFileContents, getRepoFiles } from '../services/github.js';
import { createProject as createVercelProject, triggerDeployment, waitForDeployment, addDomain } from '../services/vercel.js';
import { captureAllPages } from '../services/screenshots.js';
import { verifyBuild, extractBuildErrors } from '../services/build-verify.js';
import { notifyBuildComplete, notifyQAReady, notifyError, notifyDeploySuccess } from '../services/notifications.js';
import { setCnameRecord } from '../services/namecheap.js';
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
  const config = await getConfig();

  try {
    await supabase.from('briefs').update({ status: 'processing' }).eq('id', briefId);

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

    // Load and process brief attachments
    const { data: attachments } = await supabase
      .from('brief_attachments')
      .select('file_name, file_url, file_type')
      .eq('brief_id', briefId);

    let attachmentContents: string[] = [];
    if (attachments && attachments.length > 0) {
      await sendChatMessage(projectId, `Processing ${attachments.length} attached file(s)...`);
      const processed = await processAttachments(attachments, projectId);
      attachmentContents = processed.map(p => `[${p.fileName} (${p.fileType})]\n${p.content}`);

      for (const p of processed) {
        await supabase
          .from('brief_attachments')
          .update({ processing_status: 'processed', extracted_content: p.content.slice(0, 10000) })
          .eq('brief_id', briefId)
          .eq('file_name', p.fileName);
      }
    }

    const referenceContents = await researchReferenceUrls(brief.original_content, projectId, client.name, client.industry);
    if (referenceContents.length > 0) {
      await sendChatMessage(projectId, `Analyzed ${referenceContents.length} reference website(s) from the brief.`);
      attachmentContents = [...attachmentContents, ...referenceContents];
    }

    // Phase 1: Analysis
    await logger.info('Phase 1: Analyzing brief', 'development', projectId);
    const analysis = await analyzeBrief(brief as Brief, client, project as unknown as Project, attachmentContents);

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
        const existingCode = await getMultipleFileContents(fullName, codeFiles.slice(0, 50));

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

    await sendChatMessage(projectId, 'Verifying build before deployment...');
    await logger.info('Verifying build locally', 'development', projectId);

    let buildPassed = false;
    for (let attempt = 1; attempt <= config.max_corrections; attempt++) {
      const buildResult = await verifyBuild(fullName, projectId);
      if (buildResult.success) {
        buildPassed = true;
        await sendChatMessage(projectId, attempt === 1 ? 'Build verified successfully.' : `Build verified after ${attempt - 1} fix(es).`);
        break;
      }

      const buildErrors = extractBuildErrors(buildResult.errors || buildResult.output);
      await sendChatMessage(projectId, `Build failed (attempt ${attempt}/${config.max_corrections}): ${buildErrors.length} error(s). Auto-fixing...`);
      await logger.warn(`Build attempt ${attempt} failed: ${buildErrors.slice(0, 5).join('; ')}`, 'development', projectId);

      const allRepoFiles = await getRepoFiles(fullName);
      const allCodePaths = allRepoFiles
        .filter((f) => f.type === 'file' && /\.(tsx?|jsx?|css|json)$/.test(f.path))
        .map((f) => f.path);
      const allCode = await getMultipleFileContents(fullName, allCodePaths.slice(0, 50));

      const fixResult = await generateTaskCode(
        {
          title: 'Fix build errors',
          description: `Build attempt ${attempt} failed. Fix these errors:\n${buildErrors.join('\n')}\n\nFull output:\n${(buildResult.errors || buildResult.output).slice(0, 3000)}`,
        },
        project as unknown as Project,
        client,
        analysis.architecture,
        allCode
      );

      if (fixResult.files.length > 0) {
        await pushFiles(fullName, fixResult.files, `fix: resolve build errors (attempt ${attempt})`, projectId);
      } else {
        await logger.warn('No fix generated, stopping build loop', 'development', projectId);
        break;
      }
    }

    if (!buildPassed) {
      await supabase.from('briefs').update({ status: 'failed' }).eq('id', briefId);
      await updateProject(projectId, { agent_status: 'error' });
      await sendChatMessage(projectId, `Build failed after ${config.max_corrections} attempts. Manual intervention needed.`);
      await notifyError(project.name, 'Build failed after max correction attempts', projectId);
      return;
    }

    if (!config.auto_deploy) {
      await supabase.from('briefs').update({ status: 'completed' }).eq('id', briefId);
      await updateProject(projectId, { status: 'review', progress: 100, agent_status: 'idle', current_phase: 'complete' });
      await sendChatMessage(projectId, `Build verified successfully. Auto-deploy is disabled. Repo: ${repoUrl}\nReady for manual deployment.`);
      await notifyBuildComplete(project.name, repoUrl, projectId);
      await logger.success('Brief processing complete (deploy skipped per config)', 'development', projectId);
      return;
    }

    // Phase 4: Deploy
    await updateProject(projectId, { current_phase: 'deployment', progress: 80 });
    await logger.info('Phase 4: Deploying to Vercel', 'deployment', projectId);
    await sendChatMessage(projectId, 'Deploying to Vercel...');

    const vercelProjectId = await createVercelProject(repoName, fullName, projectId);
    await updateProject(projectId, { vercel_project_id: vercelProjectId });

    const deployment = await triggerDeployment(repoName, projectId);
    const result = await waitForDeployment(deployment.deploymentId, projectId);

    if (result.status !== 'ready') {
      await supabase.from('briefs').update({ status: 'failed' }).eq('id', briefId);
      await updateProject(projectId, { agent_status: 'error' });
      await sendChatMessage(projectId, `Deployment failed: ${result.buildLogs || 'Unknown error'}. Check the logs.`);
      await notifyError(project.name, result.buildLogs || 'Deployment failed', projectId);
      return;
    }

    await updateProject(projectId, { demo_url: result.url, progress: 90 });
    await sendChatMessage(projectId, `Deployed successfully: ${result.url}`);
    await notifyDeploySuccess(project.name, result.url, projectId);

    const demoSubdomain = clientSlug;
    const demoDomain = `${demoSubdomain}.obzide.com`;
    const cnameSet = await setCnameRecord('obzide.com', demoSubdomain, 'cname.vercel-dns.com', projectId);
    if (cnameSet) {
      const domainAdded = await addDomain(vercelProjectId, demoDomain, projectId);
      if (domainAdded) {
        const { data: existingDomain } = await supabase
          .from('domains')
          .select('id')
          .eq('project_id', projectId)
          .eq('domain_name', demoDomain)
          .maybeSingle();

        if (!existingDomain) {
          await supabase.from('domains').insert({
            project_id: projectId,
            client_id: project.client_id,
            domain_name: demoDomain,
            subdomain: demoSubdomain,
            is_demo: true,
            dns_status: 'propagating',
            ssl_status: 'pending',
            registrar: 'namecheap',
          }).maybeSingle();
        }
        await sendChatMessage(projectId, `Custom domain configured: ${demoDomain}`);
      }
    }

    if (config.auto_qa && result.url) {
      await updateProject(projectId, { current_phase: 'qa' });
      await logger.info('Phase 5: Multi-viewport QA with Vision analysis', 'qa', projectId);
      await sendChatMessage(projectId, 'Running multi-viewport QA (desktop, tablet, mobile)...');

      let qaVersion = 1;
      let screenshotResults = await captureAllPages(
        result.url,
        pages.map((p) => ({ name: p.name, route: p.route })),
        projectId,
        qaVersion
      );

      for (let qaAttempt = 0; qaAttempt < config.max_corrections; qaAttempt++) {
        const failedPages: { pageName: string; issues: string[]; score: number }[] = [];

        for (const ss of screenshotResults) {
          const pageArch = pages.find((p) => p.name === ss.pageName);
          const qaResult = await analyzeScreenshotAllViewports(
            { desktop: ss.desktopUrl, tablet: ss.tabletUrl, mobile: ss.mobileUrl },
            ss.pageName,
            pageArch?.description || ss.pageName,
            projectId
          );

          if (!qaResult.overallPass) {
            const allIssues = qaResult.viewports.flatMap(
              (v) => v.issues.map((issue) => `[${v.viewport}] ${issue}`)
            );
            failedPages.push({ pageName: ss.pageName, issues: allIssues, score: qaResult.overallScore });
            await logger.warn(
              `QA failed for ${ss.pageName} (score: ${qaResult.overallScore}/100): ${allIssues.slice(0, 3).join('; ')}`,
              'qa',
              projectId
            );
          } else {
            await logger.info(
              `QA passed for ${ss.pageName} (score: ${qaResult.overallScore}/100)`,
              'qa',
              projectId
            );
          }
        }

        if (failedPages.length === 0) {
          await sendChatMessage(projectId, qaAttempt === 0
            ? 'All pages passed multi-viewport QA on first try.'
            : `All pages passed multi-viewport QA after ${qaAttempt} correction(s).`);
          break;
        }

        if (qaAttempt === config.max_corrections - 1) {
          const summary = failedPages.map((fp) => `${fp.pageName} (${fp.score}/100)`).join(', ');
          await sendChatMessage(projectId, `${failedPages.length} page(s) still have issues after ${config.max_corrections} attempts: ${summary}. Sending to human QA.`);
          break;
        }

        await sendChatMessage(projectId, `${failedPages.length} page(s) failed QA. Auto-correcting (round ${qaAttempt + 1})...`);

        const allRepoFiles = await getRepoFiles(fullName);
        const allCodePaths = allRepoFiles
          .filter((f) => f.type === 'file' && /\.(tsx?|jsx?|css|json)$/.test(f.path))
          .map((f) => f.path);
        const allCode = await getMultipleFileContents(fullName, allCodePaths.slice(0, 50));

        const issueDescription = failedPages
          .map((fp) => `${fp.pageName} (score: ${fp.score}/100):\n${fp.issues.map((i) => `  - ${i}`).join('\n')}`)
          .join('\n\n');

        const fixResult = await generateTaskCode(
          {
            title: 'Fix visual QA issues across all viewports',
            description: `The following pages have visual issues detected by multi-viewport QA:\n\n${issueDescription}\n\nFix these visual problems for desktop, tablet, AND mobile while keeping existing functionality.`,
          },
          project as unknown as Project,
          client,
          analysis.architecture,
          allCode
        );

        if (fixResult.files.length > 0) {
          await pushFiles(fullName, fixResult.files, `fix: multi-viewport QA corrections (round ${qaAttempt + 1})`, projectId);
          const redeploy = await triggerDeployment(repoName, projectId);
          const redeployResult = await waitForDeployment(redeploy.deploymentId, projectId);

          if (redeployResult.status === 'ready') {
            await updateProject(projectId, { demo_url: redeployResult.url });
            qaVersion++;
            screenshotResults = await captureAllPages(
              redeployResult.url,
              pages.map((p) => ({ name: p.name, route: p.route })),
              projectId,
              qaVersion
            );
          } else {
            await logger.warn('Redeploy failed during QA correction', 'qa', projectId);
            break;
          }
        } else {
          break;
        }
      }

      for (const ss of screenshotResults) {
        await supabase.from('qa_screenshots').insert({
          project_id: projectId,
          page_name: ss.pageName,
          page_url: ss.pageUrl,
          desktop_url: ss.desktopUrl,
          tablet_url: ss.tabletUrl,
          mobile_url: ss.mobileUrl,
          status: 'pending',
          version_number: qaVersion,
        });
      }

      await updateProject(projectId, { status: 'qa', progress: 100, agent_status: 'idle' });
      await sendChatMessage(projectId, `QA screenshots ready for human review. ${screenshotResults.length} pages captured across 3 viewports.`);
      await notifyBuildComplete(project.name, result.url, projectId);
      await notifyQAReady(project.name, screenshotResults.length, projectId);
    } else {
      await updateProject(projectId, { status: 'review', progress: 100, agent_status: 'idle' });
      await sendChatMessage(projectId, 'Build complete. Auto-QA is disabled, project is ready for manual review.');
      await notifyBuildComplete(project.name, result.url, projectId);
    }

    await supabase.from('briefs').update({ status: 'completed' }).eq('id', briefId);
    await logger.success('Brief processing pipeline complete', 'development', projectId);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    try {
      await supabase.from('briefs').update({ status: 'failed' }).eq('id', briefId);
      await logger.error(`Brief processing failed: ${errMsg}`, 'development', projectId);
      await updateProject(projectId, { agent_status: 'error' });
      await sendChatMessage(projectId, `An error occurred: ${errMsg}`);
      const { data: proj } = await supabase.from('projects').select('name').eq('id', projectId).maybeSingle();
      if (proj) await notifyError(proj.name, errMsg, projectId);
    } catch (innerErr) {
      console.error('Error in brief-processing catch block:', innerErr);
      await supabase.from('briefs').update({ status: 'failed' }).eq('id', briefId).catch(() => {});
      await supabase.from('projects').update({ agent_status: 'error' }).eq('id', projectId).catch(() => {});
    }
  }
}
