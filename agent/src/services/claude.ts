import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../core/logger.js';
import { getConfig } from '../core/config.js';
import { getSecretWithFallback } from '../core/secrets.js';
import { getSupabase } from '../core/supabase.js';
import type { GeneratedFile, ClaudeCodeResponse, Brief, Client, Project } from '../core/types.js';

const MODELS = {
  opus: 'claude-opus-4-20250514',
  sonnet: 'claude-sonnet-4-20250514',
  haiku: 'claude-haiku-3-20250515',
} as const;

type ModelTier = keyof typeof MODELS;

let anthropic: Anthropic | null = null;

async function getClient(): Promise<Anthropic> {
  const key = await getSecretWithFallback('anthropic');
  if (!key) throw new Error('Anthropic API key not configured');
  if (!anthropic || (anthropic as unknown as Record<string, string>)._apiKey !== key) {
    anthropic = new Anthropic({ apiKey: key });
  }
  return anthropic;
}

function selectModel(task: string): string {
  const complexTasks = ['brief_analysis', 'architecture', 'qa_fix_complex', 'complex_page'];
  const simpleTasks = ['screenshot_check', 'file_classify', 'status_check'];

  if (complexTasks.includes(task)) return MODELS.opus;
  if (simpleTasks.includes(task)) return MODELS.haiku;
  return MODELS.sonnet;
}

async function trackUsage(
  model: string,
  inputTokens: number,
  outputTokens: number,
  operation: string,
  projectId?: string
): Promise<void> {
  const costPerMInput: Record<string, number> = {
    [MODELS.opus]: 15,
    [MODELS.sonnet]: 3,
    [MODELS.haiku]: 0.25,
  };
  const costPerMOutput: Record<string, number> = {
    [MODELS.opus]: 75,
    [MODELS.sonnet]: 15,
    [MODELS.haiku]: 1.25,
  };

  const inputCost = (inputTokens / 1_000_000) * (costPerMInput[model] || 3);
  const outputCost = (outputTokens / 1_000_000) * (costPerMOutput[model] || 15);

  try {
    const supabase = getSupabase();
    await supabase.from('token_usage').insert({
      project_id: projectId || null,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_estimate: inputCost + outputCost,
      operation,
    });
  } catch { /* non-critical */ }
}

async function callWithRetry(
  fn: () => Promise<Anthropic.Message>,
  maxRetries: number = 3,
  operation: string = 'unknown'
): Promise<Anthropic.Message> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const isRetryable = lastError.message.includes('overloaded') ||
        lastError.message.includes('rate_limit') ||
        lastError.message.includes('timeout') ||
        lastError.message.includes('529') ||
        lastError.message.includes('500');

      if (!isRetryable || attempt === maxRetries) throw lastError;

      const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 30_000);
      await logger.warn(
        `Claude API retry ${attempt + 1}/${maxRetries} for ${operation}: ${lastError.message}`,
        'ai'
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastError || new Error('Retry exhausted');
}

function parseCodeBlocks(text: string): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const seen = new Set<string>();

  const patterns = [
    /```(?:\w+)?\s*\n\/\/\s*FILE:\s*(.+?)\n([\s\S]*?)```/g,
    /---\s*(\S+)\s*---\n```(?:\w+)?\n([\s\S]*?)```/g,
    /```(?:\w+)?\s*\n\/\*\s*FILE:\s*(.+?)\s*\*\/\n([\s\S]*?)```/g,
  ];

  for (const regex of patterns) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const path = match[1].trim();
      if (!seen.has(path)) {
        files.push({ path, content: match[2].trim() });
        seen.add(path);
      }
    }
    if (files.length > 0) return files;
  }

  return files;
}

function extractText(response: Anthropic.Message): string {
  for (const block of response.content) {
    if (block.type === 'text') return block.text;
  }
  return '';
}

function safeParseJSON<T>(text: string, fallback: T): T {
  const cleaned = text
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .trim();

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return fallback;

  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return fallback;
  }
}

type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

function normalizeMediaType(ct: string): ImageMediaType {
  const t = ct.toLowerCase().split(';')[0].trim();
  if (t.includes('jpeg') || t.includes('jpg')) return 'image/jpeg';
  if (t.includes('gif')) return 'image/gif';
  if (t.includes('webp')) return 'image/webp';
  return 'image/png';
}

async function fetchImageBase64(url: string): Promise<{ data: string; mediaType: ImageMediaType } | null> {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    return {
      data: Buffer.from(buf).toString('base64'),
      mediaType: normalizeMediaType(res.headers.get('content-type') || 'image/png'),
    };
  } catch {
    return null;
  }
}

export async function analyzeImage(
  imageUrl: string,
  prompt: string,
  projectId?: string | null,
  modelTier: ModelTier = 'haiku'
): Promise<string> {
  const ai = await getClient();
  const model = MODELS[modelTier];

  const img = await fetchImageBase64(imageUrl);
  if (!img) return '';

  try {
    const response = await callWithRetry(
      () => ai.messages.create({
        model,
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
      2,
      'image_analysis'
    );

    await trackUsage(model, response.usage.input_tokens, response.usage.output_tokens, 'image_analysis', projectId || undefined);
    return extractText(response);
  } catch (err) {
    await logger.error(`Image analysis failed: ${err instanceof Error ? err.message : String(err)}`, 'ai', projectId || undefined);
    return '';
  }
}

export async function analyzeBrief(
  brief: Brief,
  client: Client,
  project: Project,
  attachmentContents?: string[]
): Promise<{ requirements: string[]; architecture: Record<string, unknown>; questions: { question: string; category: string }[] }> {
  const ai = await getClient();
  const model = selectModel('brief_analysis');

  const systemPrompt = `You are a senior web development architect at Obzide Tech, a premium web agency based in Panama City.
Analyze client briefs to produce structured requirements, a detailed architecture plan, and clarifying questions ONLY when genuinely ambiguous.

THINK STEP BY STEP:
1. Identify the type of project (website, e-commerce, CRM, landing page, custom app)
2. Determine all pages needed, including standard ones (404, privacy, terms, contact)
3. For each page, plan the exact sections, content blocks, and interactions
4. Identify required integrations (payment gateways, email, analytics, etc.)
5. Plan the design system (colors, fonts, spacing, animation style)
6. When a reference site is mentioned, infer standard pages and features for that industry

ANALYSIS RULES:
- Extract every detail from the brief and attached documents
- The architecture must be comprehensive enough to build the entire site from it
- Default to modern best practices for unspecified decisions
- For Panama-based projects: consider local payment gateways (Banco General, CyberSource/Banistmo, Yappy/CLAVE)

TECH STACK (always unless explicitly told otherwise):
- React + Vite + TypeScript + Tailwind CSS
- react-router-dom for routing
- lucide-react for icons
- Responsive design (mobile-first)
- Smooth animations and transitions for premium feel
- @supabase/supabase-js when backend/auth/database needed

QUESTION RULES:
- ONLY ask if genuine ambiguity would BLOCK development
- NEVER ask about things inferable from the brief or industry norms
- If fewer than 3 genuine questions, ask NONE and just build
- Maximum 5 questions

Output valid JSON only, no markdown wrapping.`;

  const attachmentSection = attachmentContents?.length
    ? `\n\nATTACHED DOCUMENTS:\n${attachmentContents.map((c, i) => `--- Attachment ${i + 1} ---\n${c}`).join('\n\n')}`
    : '';

  const userPrompt = `Analyze this client brief comprehensively.

CLIENT: ${client.name}
INDUSTRY: ${client.industry}
BRAND COLORS: ${JSON.stringify(client.brand_colors)}
BRAND FONTS: ${JSON.stringify(client.brand_fonts)}
${client.notes ? `CLIENT NOTES: ${client.notes}` : ''}

PROJECT: ${project.name}
TYPE: ${project.type}
DESCRIPTION: ${project.description}
TECHNOLOGIES: ${JSON.stringify(project.technologies)}

FULL BRIEF:
${brief.original_content}
${attachmentSection}

Respond with this exact JSON structure:
{
  "requirements": ["detailed requirement 1", ...],
  "architecture": {
    "framework": "vite-react",
    "styling": "tailwindcss",
    "pages": [{"name": "Home", "route": "/", "description": "detailed section-by-section description of content, layout, and interactions"}],
    "components": [{"name": "Navbar", "description": "contents and behavior"}],
    "dataModels": [{"name": "Product", "fields": ["id", "name", "price", "image"]}],
    "integrations": ["stripe", "emailjs"],
    "designSystem": {
      "primaryColor": "#hex",
      "secondaryColor": "#hex",
      "accentColor": "#hex",
      "fonts": {"heading": "...", "body": "..."},
      "style": "modern/minimal/bold/corporate/playful"
    }
  },
  "questions": []
}`;

  const response = await callWithRetry(
    () => ai.messages.create({
      model,
      max_tokens: 16384,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    3,
    'brief_analysis'
  );

  const text = extractText(response);
  await trackUsage(model, response.usage.input_tokens, response.usage.output_tokens, 'brief_analysis', project.id);
  await logger.info('Brief analyzed', 'ai', project.id, {
    model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  });

  const fallback = { requirements: [], architecture: {}, questions: [] };
  return safeParseJSON(text, fallback);
}

export async function generateProjectScaffold(
  project: Project,
  client: Client,
  architecture: Record<string, unknown>
): Promise<ClaudeCodeResponse> {
  const ai = await getClient();
  const model = MODELS.sonnet;

  const systemPrompt = `You are a senior frontend developer at Obzide Tech building production websites.
Generate a complete project scaffold with all configuration, shared layout, and page stubs.

THINK BEFORE CODING:
1. Review the architecture plan and identify ALL files needed
2. Plan the component hierarchy and shared styles
3. Ensure brand colors and fonts are properly configured
4. Plan responsive breakpoints and animation approach

FILE OUTPUT FORMAT:
- Every file MUST start with: // FILE: path/to/file.ext
- Wrap each file in a code block
- Use the exact path relative to project root

REQUIRED FILES:
- package.json (react, react-dom, react-router-dom, lucide-react, tailwindcss, etc.)
- vite.config.ts
- tsconfig.json, tsconfig.app.json, tsconfig.node.json
- tailwind.config.js (with brand colors as custom theme colors)
- postcss.config.js
- index.html (with Google Fonts link if custom fonts specified)
- src/main.tsx (with BrowserRouter)
- src/App.tsx (with routes for ALL pages)
- src/index.css (Tailwind directives + custom fonts + base styles + scroll animations)
- src/components/Layout.tsx (shared layout with nav + footer, responsive hamburger)
- src/components/Navbar.tsx (sticky, responsive, brand-colored)
- src/components/Footer.tsx (professional with links, social, copyright)
- One file per page in src/pages/ (realistic stub content, not lorem ipsum)

DESIGN RULES:
- Brand colors: ${JSON.stringify(client.brand_colors)} - use as primary/accent in Tailwind config
- Brand fonts: ${JSON.stringify(client.brand_fonts)} - configure in Tailwind and import in CSS
- Modern, beautiful, production-ready design
- Responsive: mobile-first, works on all screen sizes
- Add CSS transitions and keyframe animations in index.css
- Consistent spacing (8px system)
- Professional typography hierarchy
- NEVER use purple/indigo unless brand colors include them
- Use lucide-react for all icons`;

  const response = await callWithRetry(
    () => ai.messages.create({
      model,
      max_tokens: 16384,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Generate the complete scaffold for:\n\n${JSON.stringify(architecture, null, 2)}` }],
    }),
    3,
    'scaffold'
  );

  const text = extractText(response);
  const files = parseCodeBlocks(text);
  await trackUsage(model, response.usage.input_tokens, response.usage.output_tokens, 'scaffold', project.id);

  return {
    files,
    explanation: text.replace(/```[\s\S]*?```/g, '').trim().slice(0, 500),
    tokensUsed: { input: response.usage.input_tokens, output: response.usage.output_tokens },
  };
}

export async function generateTaskCode(
  task: { title: string; description: string },
  project: Project,
  client: Client,
  architecture: Record<string, unknown>,
  existingFiles: { path: string; content: string }[]
): Promise<ClaudeCodeResponse> {
  const ai = await getClient();
  const model = MODELS.sonnet;

  const relevantFiles = existingFiles.filter((f) => {
    const taskSlug = task.title.toLowerCase().replace(/[^a-z0-9]/g, '');
    const fileLower = f.path.toLowerCase();
    return fileLower.includes(taskSlug) ||
      fileLower.includes('layout') ||
      fileLower.includes('app.tsx') ||
      fileLower.includes('navbar') ||
      fileLower.includes('footer') ||
      fileLower.includes('index.css') ||
      fileLower.includes('tailwind.config');
  });

  const allOtherPaths = existingFiles
    .filter((f) => !relevantFiles.some((r) => r.path === f.path))
    .map((f) => f.path);

  const existingContext = relevantFiles
    .map((f) => `--- ${f.path} ---\n${f.content}`)
    .join('\n\n');

  const systemPrompt = `You are a senior frontend developer at Obzide Tech implementing a specific page.

THINK BEFORE CODING:
1. Study the existing components (Layout, Navbar, Footer) to match patterns
2. Plan the page structure: hero section, content sections, CTAs
3. Decide which sub-components to extract for clarity
4. Plan responsive behavior for each section

FILE OUTPUT FORMAT:
- Every file MUST start with: // FILE: path/to/file.ext
- Wrap each file in a code block
- Output ONLY files that need to be created or modified

IMPLEMENTATION RULES:
- Follow existing code patterns, component structure, and styling conventions
- Use the shared Layout, Navbar, Footer components already in the project
- Use brand colors defined in tailwind.config.js as Tailwind classes
- Every page must be fully responsive (mobile, tablet, desktop)
- Include meaningful, realistic content (not lorem ipsum)
- Add hover states, focus states, transitions, and micro-interactions
- Add scroll-triggered animations where appropriate
- Include proper loading and empty states
- Use lucide-react for all icons
- Use react-router-dom Link for internal navigation
- Create sub-components when sections get complex
- Brand colors: ${JSON.stringify(client.brand_colors)}
- Brand fonts: ${JSON.stringify(client.brand_fonts)}

QUALITY STANDARDS:
- Production-ready code - this ships to real clients
- Clean TypeScript types
- Accessible: aria labels, semantic HTML, keyboard navigation
- Proper heading hierarchy
- Minimum 200 lines per page file (unless the page is genuinely simple)`;

  const userPrompt = `TASK: ${task.title}
DESCRIPTION: ${task.description}

ARCHITECTURE:
${JSON.stringify(architecture, null, 2)}

EXISTING CODE (key files):
${existingContext}

OTHER FILES IN PROJECT (for reference, not shown):
${allOtherPaths.join(', ')}

Generate the complete, production-ready implementation.`;

  const response = await callWithRetry(
    () => ai.messages.create({
      model,
      max_tokens: 16384,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    3,
    'task_code'
  );

  const text = extractText(response);
  const files = parseCodeBlocks(text);
  await trackUsage(model, response.usage.input_tokens, response.usage.output_tokens, 'task_code', project.id);

  return {
    files,
    explanation: text.replace(/```[\s\S]*?```/g, '').trim().slice(0, 500),
    tokensUsed: { input: response.usage.input_tokens, output: response.usage.output_tokens },
  };
}

export async function generateChatResponse(
  messages: { role: 'user' | 'assistant'; content: string }[],
  projectContext: string
): Promise<{ response: string; files: GeneratedFile[]; shouldRedeploy: boolean }> {
  const ai = await getClient();
  const model = MODELS.sonnet;

  const systemPrompt = `You are the Obzide Dev Agent, an AI assistant that builds and modifies web projects.
You are chatting with a team member about a specific project.

PROJECT CONTEXT:
${projectContext}

CAPABILITIES:
- Modify code files (output them with // FILE: path comments in code blocks)
- Answer project questions
- Suggest improvements and fixes
- Explain architectural decisions

RULES:
- Be concise and direct
- If you modify code, output complete files (not diffs)
- Use the same conventions as the existing codebase
- End your response with a JSON metadata block:
\`\`\`json
{"shouldRedeploy": true/false}
\`\`\`
- Set shouldRedeploy to true when you output code changes`;

  const response = await callWithRetry(
    () => ai.messages.create({
      model,
      max_tokens: 8192,
      system: systemPrompt,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
    3,
    'chat'
  );

  const text = extractText(response);
  const files = parseCodeBlocks(text);
  await trackUsage(model, response.usage.input_tokens, response.usage.output_tokens, 'chat');

  let shouldRedeploy = false;
  const metaMatch = text.match(/```json\s*\n\s*\{[^}]*"shouldRedeploy"\s*:\s*(true|false)[^}]*\}\s*\n?\s*```/);
  if (metaMatch) {
    shouldRedeploy = metaMatch[1] === 'true';
  } else if (files.length > 0) {
    shouldRedeploy = true;
  }

  const responseText = text
    .replace(/```json\s*\n\s*\{[^}]*"shouldRedeploy"[^}]*\}\s*\n?\s*```/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .trim();

  return { response: responseText || 'Done. Changes applied.', files, shouldRedeploy };
}

export async function analyzeQARejection(
  rejectionNotes: string,
  pageName: string,
  currentCode: { path: string; content: string }[],
  briefContext: string,
  screenshotUrls?: { desktop?: string; tablet?: string; mobile?: string }
): Promise<ClaudeCodeResponse> {
  const ai = await getClient();
  const model = selectModel('qa_fix_complex');

  const codeContext = currentCode
    .map((f) => `--- ${f.path} ---\n${f.content}`)
    .join('\n\n');

  const systemPrompt = `You are a senior frontend developer at Obzide Tech fixing QA issues.
A QA screenshot was rejected. Fix the exact issues described in the rejection notes.

THINK BEFORE CODING:
1. Analyze each screenshot viewport to understand the visual issue
2. Identify which CSS/component code causes the problem
3. Plan the minimal fix that resolves the issue without side effects
4. Verify the fix works for all viewports (desktop, tablet, mobile)

RULES:
- Only output files that need changes
- Every file MUST start with: // FILE: path/to/file.ext
- Wrap each file in a code block
- Fix what was flagged precisely, don't rewrite unrelated code
- Maintain existing code style and patterns
- Ensure fixes are responsive across all viewports`;

  const userContent: Array<Record<string, unknown>> = [];

  for (const [label, url] of Object.entries(screenshotUrls || {})) {
    if (url) {
      const img = await fetchImageBase64(url);
      if (img) {
        userContent.push({ type: 'text', text: `--- ${label.toUpperCase()} VIEWPORT ---` });
        userContent.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
      }
    }
  }

  userContent.push({
    type: 'text',
    text: `PAGE: ${pageName}
REJECTION NOTES: ${rejectionNotes}

BRIEF CONTEXT:
${briefContext}

CURRENT CODE:
${codeContext}

Analyze ALL viewport screenshots above. Fix the problems described in the rejection notes, ensuring the fix works across all screen sizes.`,
  });

  const response = await callWithRetry(
    () => ai.messages.create({
      model,
      max_tokens: 16384,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent as never }],
    }),
    3,
    'qa_fix'
  );

  const text = extractText(response);
  const files = parseCodeBlocks(text);
  await trackUsage(model, response.usage.input_tokens, response.usage.output_tokens, 'qa_fix');

  return {
    files,
    explanation: text.replace(/```[\s\S]*?```/g, '').trim().slice(0, 500),
    tokensUsed: { input: response.usage.input_tokens, output: response.usage.output_tokens },
  };
}

interface ViewportQAResult {
  viewport: string;
  issues: string[];
  pass: boolean;
  score: number;
}

export async function analyzeScreenshotAllViewports(
  screenshotUrls: { desktop?: string; tablet?: string; mobile?: string },
  pageName: string,
  expectedDescription: string,
  projectId: string
): Promise<{ viewports: ViewportQAResult[]; overallPass: boolean; overallScore: number }> {
  const viewports: ViewportQAResult[] = [];

  const entries = Object.entries(screenshotUrls).filter(([, url]) => url);

  const viewportCriteria: Record<string, string> = {
    desktop: `Desktop-specific checks: overall layout balance, whitespace usage, content hierarchy, proper grid alignment, consistent section heights, brand consistency, CTA visibility above fold`,
    tablet: `Tablet-specific checks: proper responsive breakpoints at ~768px, navigation adaptation, touch-friendly button sizing (min 44px), balanced content columns, readable font sizes`,
    mobile: `Mobile-specific checks: hamburger menu present and functional, text readable without zooming (min 16px body), buttons full-width and tap-friendly, no horizontal overflow, proper vertical stacking, images properly scaled`,
  };

  for (const [viewport, url] of entries) {
    const prompt = `You are performing QA review of the "${pageName}" page - ${viewport.toUpperCase()} viewport.

EXPECTED: ${expectedDescription}

${viewportCriteria[viewport] || ''}

Score each category 0-100:
- layout: alignment, spacing, grid consistency
- typography: readability, hierarchy, sizes
- colors: brand consistency, contrast ratios
- responsiveness: viewport-appropriate rendering
- quality: professional polish, no placeholder content

Respond with JSON only:
{"issues": ["specific issue 1", ...], "pass": true/false, "scores": {"layout": 90, "typography": 85, "colors": 90, "responsiveness": 85, "quality": 80}}

Pass threshold: all scores >= 75 and no critical issues.`;

    const result = await analyzeImage(url!, prompt, projectId, 'haiku');

    const parsed = safeParseJSON<{
      issues: string[];
      pass: boolean;
      scores?: Record<string, number>;
    }>(result, { issues: [], pass: true, scores: {} });

    const scores = parsed.scores || {};
    const avgScore = Object.values(scores).length > 0
      ? Math.round(Object.values(scores).reduce((a, b) => a + b, 0) / Object.values(scores).length)
      : parsed.pass ? 90 : 60;

    viewports.push({
      viewport,
      issues: parsed.issues,
      pass: parsed.pass && avgScore >= 75,
      score: avgScore,
    });
  }

  const overallScore = viewports.length > 0
    ? Math.round(viewports.reduce((a, v) => a + v.score, 0) / viewports.length)
    : 100;

  return {
    viewports,
    overallPass: viewports.every((v) => v.pass),
    overallScore,
  };
}

export async function analyzeScreenshot(
  screenshotUrl: string,
  pageName: string,
  expectedDescription: string,
  projectId: string
): Promise<{ issues: string[]; pass: boolean }> {
  const result = await analyzeImage(
    screenshotUrl,
    `You are reviewing a QA screenshot of the "${pageName}" page.

EXPECTED: ${expectedDescription}

Analyze for: layout problems, typography issues, color problems, responsive issues, missing content, general quality.

Respond with JSON only:
{"issues": ["issue 1", "issue 2"], "pass": true/false}

If no issues found: {"issues": [], "pass": true}`,
    projectId,
    'haiku'
  );

  return safeParseJSON(result, { issues: [], pass: true });
}
