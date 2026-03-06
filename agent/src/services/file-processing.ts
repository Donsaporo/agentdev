import { analyzeImage, analyzePdfDocument } from './claude.js';
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

  const pdfBase64 = buffer.toString('base64');
  await logger.info('Sending PDF to Claude for native visual analysis', 'development', projectId);

  const visualAnalysis = await analyzePdfDocument(
    pdfBase64,
    `You are analyzing a PDF document attached to a client brief for a web development project.

EXTRACT EVERYTHING USEFUL FROM EVERY PAGE:
1. If any page contains UI mockups, wireframes, or design references:
   - Describe the exact layout (header, sidebar, content areas, footer)
   - List every UI component visible (buttons, cards, forms, tables, navbars, modals)
   - Extract exact hex color codes visible or describe colors precisely
   - Describe typography: font styles, sizes, weights, hierarchy
   - Note spacing, alignment, and grid structure
   - Describe any icons, images, or illustrations

2. If any page contains brand guidelines:
   - Extract ALL color codes (primary, secondary, accent, neutrals)
   - Extract font names and usage rules
   - Extract logo usage rules
   - Extract spacing/grid specifications

3. If any page contains text content/requirements:
   - Summarize the key requirements
   - Extract any feature lists, user stories, or specifications
   - Note any technical requirements mentioned

4. If any page contains screenshots of reference websites:
   - Describe the design style, layout patterns, and UI elements
   - Note what the client likely wants to replicate

Be extremely detailed and specific. Label each page you analyze with [Page N].
This analysis will be used to build the actual website.`,
    projectId,
    'sonnet'
  );

  return { text, visualAnalysis };
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
