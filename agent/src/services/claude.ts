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
  const regex = /```(?:\w+)?\s*\n\/\/\s*FILE:\s*(.+?)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    files.push({ path: match[1].trim(), content: match[2].trim() });
  }

  if (files.length === 0) {
    const altRegex = /---\s*(\S+)\s*---\n```(?:\w+)?\n([\s\S]*?)```/g;
    while ((match = altRegex.exec(text)) !== null) {
      files.push({ path: match[1].trim(), content: match[2].trim() });
    }
  }

  return files;
}

export async function analyzeBrief(
  brief: Brief,
  client: Client,
  project: Project
): Promise<{ requirements: string[]; architecture: Record<string, unknown>; questions: { question: string; category: string }[] }> {
  const ai = getClient();
  const config = await getConfig();

  const systemPrompt = `You are an expert web development architect at Obzide Tech, a web development agency.
Your job is to analyze client briefs and produce structured requirements, an architecture plan, and clarifying questions if needed.

RULES:
- Only ask questions if there is genuine ambiguity that would block development
- Never ask questions whose answers are already in the brief
- Be thorough but concise
- Output valid JSON only, no markdown wrapping`;

  const userPrompt = `Analyze this client brief and produce a structured plan.

CLIENT: ${client.name}
INDUSTRY: ${client.industry}
BRAND COLORS: ${JSON.stringify(client.brand_colors)}
BRAND FONTS: ${JSON.stringify(client.brand_fonts)}

PROJECT: ${project.name}
TYPE: ${project.type}
DESCRIPTION: ${project.description}

BRIEF:
${brief.original_content}

PAGES/SCREENS LISTED: ${JSON.stringify(brief.pages_screens)}
FEATURES LISTED: ${JSON.stringify(brief.features)}

Respond with this exact JSON structure:
{
  "requirements": ["requirement 1", "requirement 2", ...],
  "architecture": {
    "framework": "next.js or vite-react",
    "styling": "tailwindcss",
    "pages": [{"name": "...", "route": "...", "description": "..."}],
    "components": ["..."],
    "dataModels": ["..."],
    "integrations": ["..."]
  },
  "questions": [{"question": "...", "category": "design|functionality|content|technical"}]
}`;

  const response = await ai.messages.create({
    model: config.default_model,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';

  await logger.info(
    'Brief analyzed by Claude',
    'ai',
    project.id,
    { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens }
  );

  try {
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    await logger.error('Failed to parse Claude brief analysis response', 'ai', project.id, { rawText: text.slice(0, 500) });
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

  const systemPrompt = `You are an expert frontend developer at Obzide Tech.
Generate a complete project scaffold based on the architecture plan.
Use the client's brand colors and fonts throughout.

CRITICAL RULES:
- Use React + Vite + TypeScript + Tailwind CSS
- Create production-ready, beautiful code
- Every file must be prefixed with a comment: // FILE: path/to/file.tsx
- Wrap each file in a code block
- Include package.json, tailwind.config.js, vite.config.ts, tsconfig files
- Create all pages as stubs with proper routing
- Use lucide-react for icons
- Make the design beautiful and modern, not cookie-cutter
- Brand colors: ${JSON.stringify(client.brand_colors)}
- Brand fonts: ${JSON.stringify(client.brand_fonts)}`;

  const response = await ai.messages.create({
    model: config.default_model,
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: 'user', content: `Generate the complete scaffold for this project:\n\n${JSON.stringify(architecture, null, 2)}` }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
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

  const systemPrompt = `You are an expert frontend developer at Obzide Tech.
Implement a specific page/feature for a client project.

CRITICAL RULES:
- Output only the files that need to be created or modified
- Every file must be prefixed with a comment: // FILE: path/to/file.tsx
- Wrap each file in a code block
- Use React + TypeScript + Tailwind CSS
- Use lucide-react for icons
- Make the design production-ready and visually impressive
- Follow the existing code style and patterns
- Brand colors: ${JSON.stringify(client.brand_colors)}
- Brand fonts: ${JSON.stringify(client.brand_fonts)}`;

  const userPrompt = `TASK: ${task.title}
DESCRIPTION: ${task.description}

ARCHITECTURE:
${JSON.stringify(architecture, null, 2)}

EXISTING CODE:
${existingContext}

Generate the complete implementation.`;

  const response = await ai.messages.create({
    model: config.default_model,
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
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

  const systemPrompt = `You are the Obzide Dev Agent, an AI assistant that helps build and modify web projects.
You are chatting with a team member about a specific project.

PROJECT CONTEXT:
${projectContext}

CAPABILITIES:
- Modify code files (output them with // FILE: path/to/file comments in code blocks)
- Answer questions about the project
- Suggest improvements

RULES:
- Be concise and helpful
- If you modify code, set "shouldRedeploy": true in your response
- Respond conversationally but include code when needed
- End your response with a JSON block containing metadata:
\`\`\`json
{"shouldRedeploy": true/false}
\`\`\``;

  const response = await ai.messages.create({
    model: config.default_model,
    max_tokens: 4096,
    system: systemPrompt,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
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
  briefContext: string
): Promise<ClaudeCodeResponse> {
  const ai = getClient();
  const config = await getConfig();

  const codeContext = currentCode
    .map((f) => `--- ${f.path} ---\n${f.content}`)
    .join('\n\n');

  const systemPrompt = `You are an expert frontend developer at Obzide Tech.
A QA screenshot was rejected. Fix the issues described in the rejection notes.

RULES:
- Only output files that need changes
- Every file must be prefixed with a comment: // FILE: path/to/file.tsx
- Wrap each file in a code block
- Be precise - only fix what was flagged
- Maintain existing code style`;

  const userPrompt = `PAGE: ${pageName}
REJECTION NOTES: ${rejectionNotes}

BRIEF CONTEXT:
${briefContext}

CURRENT CODE:
${codeContext}

Fix the issues and output the corrected files.`;

  const response = await ai.messages.create({
    model: config.default_model,
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  const files = parseCodeBlocks(text);

  return {
    files,
    explanation: text.replace(/```[\s\S]*?```/g, '').trim().slice(0, 500),
    tokensUsed: { input: response.usage.input_tokens, output: response.usage.output_tokens },
  };
}
