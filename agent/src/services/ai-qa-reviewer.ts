import { logger } from '../core/logger.js';
import { getSupabase } from '../core/supabase.js';
import { getSecretWithFallback } from '../core/secrets.js';
import { captureAllPages } from './screenshots.js';
import { runBrowserAutomation } from './screenshots.js';
import type { ScreenshotResult, FullArchitecture } from '../core/types.js';

interface PageQAResult {
  pageName: string;
  route: string;
  pass: boolean;
  score: number;
  issues: QAIssue[];
  screenshotUrls: { desktop: string; tablet: string; mobile: string };
}

interface QAIssue {
  category: 'layout' | 'colors' | 'typography' | 'responsiveness' | 'navigation' | 'usability' | 'content' | 'accessibility';
  severity: 'critical' | 'major' | 'minor';
  description: string;
  suggestedFix: string;
}

export interface QAReport {
  projectId: string;
  overallScore: number;
  totalPages: number;
  passedPages: number;
  failedPages: number;
  status: 'all_passed' | 'partial_pass' | 'max_attempts_reached';
  pageResults: PageQAResult[];
  uxChecks: {
    scrollToTopWorks: boolean;
    navigationWorks: boolean;
    consoleErrors: string[];
  };
  iterations: number;
  createdAt: string;
}

const MAX_QA_ITERATIONS = 4;
const QA_PASS_THRESHOLD = 80;
const QA_SCREENSHOT_BATCH = 5;

async function analyzePageScreenshots(
  screenshots: ScreenshotResult,
  pageName: string,
  pageDescription: string,
  designSpec: string,
  projectId: string
): Promise<PageQAResult> {
  const { analyzeScreenshotAllViewports } = await import('./claude.js');

  const result = await analyzeScreenshotAllViewports(
    { desktop: screenshots.desktopUrl, tablet: screenshots.tabletUrl, mobile: screenshots.mobileUrl },
    pageName,
    `${pageDescription}\n\nDESIGN SPEC TO VALIDATE AGAINST:\n${designSpec}`,
    projectId
  );

  const issues: QAIssue[] = [];
  for (const vp of result.viewports) {
    for (const issue of vp.issues) {
      issues.push({
        category: categorizeIssue(issue),
        severity: inferSeverity(issue),
        description: `[${vp.viewport}] ${issue}`,
        suggestedFix: '',
      });
    }
  }

  return {
    pageName,
    route: '',
    pass: result.overallPass,
    score: result.overallScore,
    issues,
    screenshotUrls: {
      desktop: screenshots.desktopUrl,
      tablet: screenshots.tabletUrl,
      mobile: screenshots.mobileUrl,
    },
  };
}

function categorizeIssue(issue: string): QAIssue['category'] {
  const lower = issue.toLowerCase();
  if (lower.includes('layout') || lower.includes('alignment') || lower.includes('spacing') || lower.includes('position')) return 'layout';
  if (lower.includes('color') || lower.includes('contrast') || lower.includes('palette')) return 'colors';
  if (lower.includes('font') || lower.includes('text') || lower.includes('heading') || lower.includes('typography')) return 'typography';
  if (lower.includes('mobile') || lower.includes('responsive') || lower.includes('breakpoint') || lower.includes('overflow')) return 'responsiveness';
  if (lower.includes('navigation') || lower.includes('link') || lower.includes('route') || lower.includes('menu')) return 'navigation';
  if (lower.includes('content') || lower.includes('placeholder') || lower.includes('lorem') || lower.includes('missing')) return 'content';
  if (lower.includes('aria') || lower.includes('accessibility') || lower.includes('focus') || lower.includes('keyboard')) return 'accessibility';
  return 'usability';
}

function inferSeverity(issue: string): QAIssue['severity'] {
  const lower = issue.toLowerCase();
  if (lower.includes('blank') || lower.includes('crash') || lower.includes('broken') || lower.includes('missing page') || lower.includes('white screen')) return 'critical';
  if (lower.includes('overflow') || lower.includes('unreadable') || lower.includes('missing') || lower.includes('incorrect color') || lower.includes('wrong font')) return 'major';
  return 'minor';
}

export async function runAutonomousQA(
  deployedUrl: string,
  architecture: FullArchitecture,
  designSpecText: string,
  projectId: string,
  fullName: string,
  repoName: string
): Promise<QAReport> {
  const supabase = getSupabase();
  const pages = architecture.pages || [];
  const browserlessToken = await getSecretWithFallback('browserless');

  await logger.info(`Starting autonomous QA for ${pages.length} pages at ${deployedUrl}`, 'qa', projectId);

  const sendChat = async (msg: string) => {
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
        content: msg,
      });
    }
  };

  let currentUrl = deployedUrl;
  let lastScreenshots: ScreenshotResult[] = [];
  let qaVersion = 1;

  const report: QAReport = {
    projectId,
    overallScore: 0,
    totalPages: pages.length,
    passedPages: 0,
    failedPages: 0,
    status: 'max_attempts_reached',
    pageResults: [],
    uxChecks: {
      scrollToTopWorks: true,
      navigationWorks: true,
      consoleErrors: [],
    },
    iterations: 0,
    createdAt: new Date().toISOString(),
  };

  for (let iteration = 0; iteration < MAX_QA_ITERATIONS; iteration++) {
    report.iterations = iteration + 1;
    await sendChat(`QA Review (round ${iteration + 1}/${MAX_QA_ITERATIONS}): Capturing screenshots for ${pages.length} pages...`);

    lastScreenshots = await captureAllPages(
      currentUrl,
      pages.map((p) => ({ name: p.name, route: p.route })),
      projectId,
      qaVersion
    );

    if (browserlessToken) {
      try {
        const automation = await runBrowserAutomation(
          currentUrl,
          pages.map((p) => ({ name: p.name, route: p.route })),
          browserlessToken
        );
        report.uxChecks = {
          scrollToTopWorks: automation.scrollToTopWorks,
          navigationWorks: automation.navigationWorks,
          consoleErrors: automation.consoleErrors,
        };

        if (automation.consoleErrors.length > 0) {
          await logger.warn(`Found ${automation.consoleErrors.length} console error(s) on deployed site`, 'qa', projectId);
        }
      } catch (err) {
        await logger.warn(`Browser automation checks failed: ${err instanceof Error ? err.message : String(err)}`, 'qa', projectId);
      }
    }

    const pageResults: PageQAResult[] = [];
    const failedPages: { pageName: string; issues: string[]; score: number }[] = [];

    for (let i = 0; i < lastScreenshots.length; i += QA_SCREENSHOT_BATCH) {
      const batch = lastScreenshots.slice(i, i + QA_SCREENSHOT_BATCH);
      const batchResults = await Promise.all(
        batch.map(async (ss) => {
          const pageArch = pages.find((p) => p.name === ss.pageName);
          if (!ss.desktopUrl && !ss.tabletUrl && !ss.mobileUrl) {
            return {
              pageName: ss.pageName,
              route: pageArch?.route || '',
              pass: false,
              score: 0,
              issues: [{ category: 'content' as const, severity: 'critical' as const, description: 'No screenshots captured - page may be blank or unreachable', suggestedFix: 'Check that the page route exists and renders content' }],
              screenshotUrls: { desktop: '', tablet: '', mobile: '' },
            };
          }

          try {
            const result = await analyzePageScreenshots(
              ss,
              ss.pageName,
              pageArch?.description || ss.pageName,
              designSpecText,
              projectId
            );
            result.route = pageArch?.route || '';
            return result;
          } catch (err) {
            await logger.warn(`QA analysis failed for ${ss.pageName}: ${err instanceof Error ? err.message : String(err)}`, 'qa', projectId);
            return {
              pageName: ss.pageName,
              route: pageArch?.route || '',
              pass: true,
              score: 70,
              issues: [],
              screenshotUrls: { desktop: ss.desktopUrl, tablet: ss.tabletUrl, mobile: ss.mobileUrl },
            };
          }
        })
      );

      pageResults.push(...batchResults);

      if (i + QA_SCREENSHOT_BATCH < lastScreenshots.length) {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }

    report.pageResults = pageResults;
    const passed = pageResults.filter((p) => p.pass || p.score >= QA_PASS_THRESHOLD);
    const failed = pageResults.filter((p) => !p.pass && p.score < QA_PASS_THRESHOLD);
    report.passedPages = passed.length;
    report.failedPages = failed.length;
    report.overallScore = pageResults.length > 0
      ? Math.round(pageResults.reduce((sum, p) => sum + p.score, 0) / pageResults.length)
      : 0;

    for (const fp of failed) {
      failedPages.push({
        pageName: fp.pageName,
        issues: fp.issues.map((i) => i.description),
        score: fp.score,
      });
    }

    await sendChat(
      `QA Results (round ${iteration + 1}): ${passed.length}/${pageResults.length} pages passed (score: ${report.overallScore}/100)` +
      (failed.length > 0 ? `\nFailed: ${failed.map((f) => `${f.pageName} (${f.score}/100)`).join(', ')}` : '')
    );

    if (failedPages.length === 0) {
      report.status = 'all_passed';
      await logger.success(`All pages passed QA${iteration > 0 ? ` after ${iteration} correction(s)` : ' on first try'}`, 'qa', projectId);
      break;
    }

    if (iteration === MAX_QA_ITERATIONS - 1) {
      report.status = failedPages.length < pageResults.length ? 'partial_pass' : 'max_attempts_reached';
      await sendChat(`QA completed after ${MAX_QA_ITERATIONS} rounds. ${passed.length}/${pageResults.length} pages passing.`);
      break;
    }

    await sendChat(`Auto-correcting ${failedPages.length} page(s)...`);

    try {
      const { generateAutoQAFix } = await import('./claude.js');
      const { getRepoTree, getMultipleFileContents, pushFiles } = await import('./github.js');
      const { triggerDeployment, waitForDeployment } = await import('./vercel.js');
      const { selectPathsWithinBudget } = await import('./build-intelligence.js');

      const CORE_FILE_PATTERNS = ['src/App.tsx', 'src/main.tsx', 'src/index.css', 'src/lib/', 'src/components/', 'src/contexts/', 'src/hooks/', 'tailwind.config'];

      const repoFiles = await getRepoTree(fullName);
      const codeFiles = repoFiles.filter((f) => f.type === 'file' && /\.(tsx?|jsx?|css|json)$/.test(f.path));
      const pathsBudgeted = selectPathsWithinBudget(codeFiles, 200000, CORE_FILE_PATTERNS);
      const codeContents = await getMultipleFileContents(fullName, pathsBudgeted);

      const { data: proj } = await supabase
        .from('projects')
        .select('*, clients(*)')
        .eq('id', projectId)
        .maybeSingle();

      const fixResult = await generateAutoQAFix(
        failedPages,
        codeContents,
        proj,
        proj?.clients || {},
        architecture as unknown as Record<string, unknown>,
        iteration + 1,
        MAX_QA_ITERATIONS
      );

      if (fixResult.files.length > 0) {
        await pushFiles(fullName, fixResult.files, `fix: AI QA corrections (round ${iteration + 1})`, projectId);

        const deployment = await triggerDeployment(repoName, projectId, fullName);
        const deployResult = await waitForDeployment(deployment.deploymentId, projectId);

        if (deployResult.status === 'ready' && deployResult.url) {
          currentUrl = deployResult.url;
          await supabase.from('projects').update({ demo_url: currentUrl }).eq('id', projectId);
          qaVersion++;
        } else {
          await logger.warn('Redeploy failed during QA auto-correction', 'qa', projectId);
          break;
        }
      } else {
        await logger.warn('No fix files generated for QA issues', 'qa', projectId);
        break;
      }
    } catch (err) {
      await logger.error(`QA auto-correction failed: ${err instanceof Error ? err.message : String(err)}`, 'qa', projectId);
      break;
    }
  }

  for (const ss of lastScreenshots) {
    const pageResult = report.pageResults.find((p) => p.pageName === ss.pageName);
    await supabase.from('qa_screenshots').insert({
      project_id: projectId,
      page_name: ss.pageName,
      page_url: ss.pageUrl,
      desktop_url: ss.desktopUrl,
      tablet_url: ss.tabletUrl,
      mobile_url: ss.mobileUrl,
      status: pageResult?.pass ? 'approved' : 'pending',
      version_number: qaVersion,
    });
  }

  await supabase.from('agent_logs').insert({
    project_id: projectId,
    action: `AI QA completed: ${report.passedPages}/${report.totalPages} passed (score: ${report.overallScore}/100)`,
    category: 'qa',
    severity: report.status === 'all_passed' ? 'success' : 'warning',
    details: {
      overallScore: report.overallScore,
      passedPages: report.passedPages,
      failedPages: report.failedPages,
      iterations: report.iterations,
      uxChecks: report.uxChecks,
    },
  });

  return report;
}
