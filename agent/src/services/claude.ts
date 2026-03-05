import Anthropic from '@anthropic-ai/sdk';
import { env } from '../core/env.js';
import { logger } from '../core/logger.js';
import { getConfig } from '../core/config.js';
import type { GeneratedFile, ClaudeCodeResponse, Brief, Client, Project } from '../core/types.js';

let anthropic: Anthropic | null = null;

function getClient(): Anthropic {
  if (!anthropic) {
    anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return anthropic;
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

type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

function normalizeMediaType(ct: string): ImageMediaType {
  const t = ct.toLowerCase().split(';')[0].trim();
  if (t.includes('jpeg') || t.includes('jpg')) return 'image/jpeg';
  if (t.includes('gif')) return 'image/gif';
  if (t.includes('webp')) return 'image/webp';
  return 'image/png';
}

async function fetchImageBase64(url: string): Promise<{ data: string; mediaType: ImageMediaType } | null> {
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
  projectId?: string | null
): Promise<string> {
  const ai = getClient();
  const config = await getConfig();

  const img = await fetchImageBase64(imageUrl);
  if (!img) return '';

  try {
    const response = await ai.messages.create({
      model: config.default_model,
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } },
          { type: 'text', text: prompt },
        ],
      }],
    });

    await logger.info('Image analyzed', 'ai', projectId || undefined, {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    });

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
  const ai = getClient();
  const config = await getConfig();

  const systemPrompt = `You are a senior web development architect at Obzide Tech, a premium web agency.
Analyze client briefs to produce structured requirements, a detailed architecture plan, and clarifying questions ONLY when genuinely ambiguous.

ANALYSIS RULES:
- Extract every detail from the brief and attached documents
- When a reference site is mentioned, infer standard pages and features for that industry
- Include standard pages any professional site needs (404, privacy policy, terms, contact)
- Default to modern best practices for unspecified decisions
- The architecture must be comprehensive enough to build the entire site from it

TECH STACK (always unless explicitly told otherwise):
- React + Vite + TypeScript + Tailwind CSS
- react-router-dom for routing
- lucide-react for icons
- Responsive design (mobile-first)
- Smooth animations and transitions for premium feel

QUESTION RULES:
- ONLY ask if genuine ambiguity would BLOCK development
- NEVER ask about things inferable from the brief or industry norms
- NEVER ask about technical implementation details
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

  const response = await ai.messages.create({
    model: config.default_model,
    max_tokens: 16384,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = extractText(response);
  await logger.info('Brief analyzed', 'ai', project.id, {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  });

  try {
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    await logger.error('Failed to parse brief analysis', 'ai', project.id, { rawText: text.slice(0, 1000) });
    return { requirements: [], architecture: {}, questions: [] };
  }
}

export async function generateProjectScaffold(
  project: Project,
  client: Client,
  architecture: Record<string, unknown>
): Promise<ClaudeCodeResponse> {
  const ai = getClient();
  const config = await getConfig();

  const systemPrompt = `You are a senior frontend developer at Obzide Tech building production websites.
Generate a complete project scaffold with all configuration, shared layout, and page stubs.

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
- index.html
- src/main.tsx (with BrowserRouter)
- src/App.tsx (with routes for ALL pages)
- src/index.css (Tailwind directives + custom fonts + base styles + scroll animations)
- src/components/Layout.tsx (shared layout with nav + footer, responsive hamburger)
- src/components/Navbar.tsx (sticky, responsive, brand-colored)
- src/components/Footer.tsx (professional with links, social, copyright)
- One file per page in src/pages/ (realistic stub content, not lorem ipsum)

DESIGN RULES:
- Brand colors: ${JSON.stringify(client.brand_colors)} — use as primary/accent in Tailwind config
- Brand fonts: ${JSON.stringify(client.brand_fonts)} — configure in Tailwind and import in CSS
- Modern, beautiful, production-ready design
- Responsive: mobile-first, works on all screen sizes
- Add CSS transitions and keyframe animations in index.css
- Consistent spacing (8px system)
- Professional typography hierarchy
- NEVER use purple/indigo unless brand colors include them
- Use lucide-react for all icons`;

  const response = await ai.messages.create({
    model: config.default_model,
    max_tokens: 16384,
    system: systemPrompt,
    messages: [{ role: 'user', content: `Generate the complete scaffold for:\n\n${JSON.stringify(architecture, null, 2)}` }],
  });

  const text = extractText(response);
  const files = parseCodeBlocks(text);

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
  const ai = getClient();
  const config = await getConfig();

  const existingContext = existingFiles
    .map((f) => `--- ${f.path} ---\n${f.content}`)
    .join('\n\n');

  const systemPrompt = `You are a senior frontend developer at Obzide Tech implementing a specific page.

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
- Production-ready code
- Clean TypeScript types
- Accessible: aria labels, semantic HTML, keyboard navigation
- Proper heading hierarchy`;

  const userPrompt = `TASK: ${task.title}
DESCRIPTION: ${task.description}

ARCHITECTURE:
${JSON.stringify(architecture, null, 2)}

EXISTING CODE:
${existingContext}

Generate the complete, production-ready implementation.`;

  const response = await ai.messages.create({
    model: config.default_model,
    max_tokens: 16384,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = extractText(response);
  const files = parseCodeBlocks(text);

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
  const ai = getClient();
  const config = await getConfig();

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

  const response = await ai.messages.create({
    model: config.default_model,
    max_tokens: 8192,
    system: systemPrompt,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  });

  const text = extractText(response);
  const files = parseCodeBlocks(text);

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
  const ai = getClient();
  const config = await getConfig();

  const codeContext = currentCode
    .map((f) => `--- ${f.path} ---\n${f.content}`)
    .join('\n\n');

  const systemPrompt = `You are a senior frontend developer at Obzide Tech fixing QA issues.
A QA screenshot was rejected. Fix the exact issues described in the rejection notes.

RULES:
- Only output files that need changes
- Every file MUST start with: // FILE: path/to/file.ext
- Wrap each file in a code block
- Fix what was flagged precisely, don't rewrite unrelated code
- Maintain existing code style and patterns
- Ensure fixes are responsive across all viewports`;

  const userContent: Array<Record<string, unknown>> = [];

  if (screenshotUrls?.desktop) {
    const img = await fetchImageBase64(screenshotUrls.desktop);
    if (img) {
      userContent.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
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

Look at the screenshot above (if provided) to understand the visual issue. Fix the problems described in the rejection notes.`,
  });

  const response = await ai.messages.create({
    model: config.default_model,
    max_tokens: 16384,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent as never }],
  });

  const text = extractText(response);
  const files = parseCodeBlocks(text);

  return {
    files,
    explanation: text.replace(/```[\s\S]*?```/g, '').trim().slice(0, 500),
    tokensUsed: { input: response.usage.input_tokens, output: response.usage.output_tokens },
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

Analyze this screenshot for visual issues:
- Layout problems (overlapping, misalignment, broken grids)
- Typography issues (unreadable text, wrong hierarchy, poor contrast)
- Color problems (wrong brand colors, poor contrast ratios)
- Responsive issues (overflow, cut-off elements)
- Missing content (empty sections, broken images, visible placeholder text)
- General quality (does it look professional and production-ready?)

Respond with JSON only:
{"issues": ["issue 1", "issue 2"], "pass": true/false}

If no issues found: {"issues": [], "pass": true}`,
    projectId
  );

  try {
    const cleaned = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return { issues: [], pass: true };
  }
}
