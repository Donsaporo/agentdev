import { analyzeImage } from './claude.js';
import { logger } from '../core/logger.js';

interface ProcessedAttachment {
  fileName: string;
  fileType: string;
  content: string;
  visualAnalysis?: string;
}

export async function processAttachments(
  attachments: { file_name: string; file_url: string; file_type: string }[],
  projectId: string
): Promise<ProcessedAttachment[]> {
  const results: ProcessedAttachment[] = [];

  for (const attachment of attachments) {
    try {
      let content = '';
      let visualAnalysis = '';

      if (attachment.file_type === 'pdf') {
        const pdfResult = await extractPdfWithVision(attachment.file_url, projectId);
        content = pdfResult.text;
        visualAnalysis = pdfResult.visualAnalysis;
      } else if (attachment.file_type === 'image') {
        content = await describeImage(attachment.file_url, projectId);
        visualAnalysis = content;
      } else if (attachment.file_type === 'spreadsheet') {
        content = await extractSpreadsheetData(attachment.file_url);
      } else {
        content = await extractTextFile(attachment.file_url);
      }

      if (content || visualAnalysis) {
        const combined = visualAnalysis
          ? `${content}\n\n[VISUAL ANALYSIS]\n${visualAnalysis}`
          : content;
        results.push({
          fileName: attachment.file_name,
          fileType: attachment.file_type,
          content: combined,
          visualAnalysis,
        });
      }

      await logger.info(`Processed attachment: ${attachment.file_name}`, 'development', projectId);
    } catch (err) {
      await logger.error(
        `Failed to process attachment ${attachment.file_name}: ${err instanceof Error ? err.message : String(err)}`,
        'development',
        projectId
      );
    }
  }

  return results;
}

async function extractPdfWithVision(
  url: string,
  projectId: string
): Promise<{ text: string; visualAnalysis: string }> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch PDF: ${response.status}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  let text = '';

  try {
    const pdfParse = (await import('pdf-parse')).default;
    const data = await pdfParse(buffer);
    text = data.text || '';
  } catch (err) {
    await logger.warn(
      `PDF text extraction failed, falling back to vision only: ${err instanceof Error ? err.message : String(err)}`,
      'development',
      projectId
    );
  }

  const pageImages = await renderPdfPagesToImages(buffer, projectId);
  if (pageImages.length === 0) {
    return { text, visualAnalysis: '' };
  }

  await logger.info(`Rendered ${pageImages.length} PDF page(s) for visual analysis`, 'development', projectId);

  const visualParts: string[] = [];
  const pagesToAnalyze = pageImages.slice(0, 10);

  const BATCH_SIZE = 3;
  for (let i = 0; i < pagesToAnalyze.length; i += BATCH_SIZE) {
    const batch = pagesToAnalyze.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (imgData, batchIdx) => {
        const pageNum = i + batchIdx + 1;
        const analysis = await analyzeImage(
          imgData,
          `You are analyzing page ${pageNum} of a PDF document attached to a client brief for a web development project.

EXTRACT EVERYTHING USEFUL:
1. If this page contains UI mockups, wireframes, or design references:
   - Describe the exact layout (header, sidebar, content areas, footer)
   - List every UI component visible (buttons, cards, forms, tables, navbars, modals)
   - Extract exact hex color codes visible or describe colors precisely
   - Describe typography: font styles, sizes, weights, hierarchy
   - Note spacing, alignment, and grid structure
   - Describe any icons, images, or illustrations

2. If this page contains brand guidelines:
   - Extract ALL color codes (primary, secondary, accent, neutrals)
   - Extract font names and usage rules
   - Extract logo usage rules
   - Extract spacing/grid specifications

3. If this page contains text content/requirements:
   - Summarize the key requirements
   - Extract any feature lists, user stories, or specifications
   - Note any technical requirements mentioned

4. If this page contains screenshots of reference websites:
   - Describe the design style, layout patterns, and UI elements
   - Note what the client likely wants to replicate

Be extremely detailed and specific. This analysis will be used to build the actual website.`,
          projectId,
          'sonnet'
        );
        return `[Page ${pageNum}]\n${analysis}`;
      })
    );
    visualParts.push(...batchResults);
  }

  return { text, visualAnalysis: visualParts.join('\n\n') };
}

async function renderPdfPagesToImages(
  buffer: Buffer,
  projectId: string
): Promise<string[]> {
  try {
    const { writeFile, mkdir, readFile, rm, readdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { exec } = await import('node:child_process');

    const tempDir = `/tmp/pdf-render-${Date.now()}`;
    await mkdir(tempDir, { recursive: true });
    const pdfPath = join(tempDir, 'input.pdf');
    await writeFile(pdfPath, buffer);

    const hasMutools = await new Promise<boolean>((resolve) => {
      exec('which mutool', (err) => resolve(!err));
    });

    if (!hasMutools) {
      const hasConvert = await new Promise<boolean>((resolve) => {
        exec('which convert', (err) => resolve(!err));
      });

      if (!hasConvert) {
        await logger.info('No PDF renderer available (mutool/convert), skipping visual analysis', 'development', projectId);
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
        return [];
      }

      await new Promise<void>((resolve, reject) => {
        exec(
          `convert -density 150 -quality 85 "${pdfPath}" "${join(tempDir, 'page-%03d.png')}"`,
          { timeout: 60_000 },
          (err) => (err ? reject(err) : resolve())
        );
      });
    } else {
      await new Promise<void>((resolve, reject) => {
        exec(
          `mutool convert -O resolution=150 -o "${join(tempDir, 'page-%03d.png')}" "${pdfPath}"`,
          { timeout: 60_000 },
          (err) => (err ? reject(err) : resolve())
        );
      });
    }

    const files = await readdir(tempDir);
    const pngFiles = files.filter((f) => f.endsWith('.png')).sort();

    const base64Images: string[] = [];
    for (const pngFile of pngFiles) {
      const imgBuffer = await readFile(join(tempDir, pngFile));
      const b64 = `data:image/png;base64,${imgBuffer.toString('base64')}`;
      base64Images.push(b64);
    }

    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    return base64Images;
  } catch (err) {
    await logger.warn(
      `PDF page rendering failed: ${err instanceof Error ? err.message : String(err)}`,
      'development',
      projectId
    );
    return [];
  }
}

const IMAGE_ANALYSIS_PROMPT = `Describe this image in exhaustive detail for use in a web development project brief.

If it is a LOGO: describe the design, shapes, exact colors (hex if possible), typography, and style.

If it is a SCREENSHOT or UI MOCKUP:
- Describe the full layout: header, navigation, hero, content sections, sidebar, footer
- List every UI component: buttons (shape, color, text), cards, forms, inputs, tables, modals, dropdowns
- Describe the color palette: background, text, accent, borders (estimate hex codes)
- Describe typography: headings, body text, sizes, weights
- Describe spacing, alignment, grid columns, padding
- Describe any animations or interactive elements suggested by the design
- Note the overall design style: minimal, bold, corporate, playful, etc.

If it is a BRAND MANUAL page: extract ALL brand guidelines, colors (with hex), fonts, spacing rules, logo usage rules.

If it is a WIREFRAME: describe every section, element placement, content hierarchy, and interaction flow.`;

async function describeImage(url: string, projectId: string): Promise<string> {
  return analyzeImage(url, IMAGE_ANALYSIS_PROMPT, projectId, 'sonnet');
}

async function extractSpreadsheetData(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch spreadsheet: ${response.status}`);

  const buffer = Buffer.from(await response.arrayBuffer());

  try {
    const XLSX = await import('xlsx');
    const workbook = XLSX.read(buffer, { type: 'buffer' });

    const results: string[] = [];
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(sheet);
      results.push(`Sheet: ${sheetName}\n${csv}`);
    }

    return results.join('\n\n');
  } catch (err) {
    throw new Error(`Spreadsheet parsing failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function extractTextFile(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch file: ${response.status}`);
  return response.text();
}
