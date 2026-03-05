import { analyzeImage } from './claude.js';
import { logger } from '../core/logger.js';

interface ProcessedAttachment {
  fileName: string;
  fileType: string;
  content: string;
}

export async function processAttachments(
  attachments: { file_name: string; file_url: string; file_type: string }[],
  projectId: string
): Promise<ProcessedAttachment[]> {
  const results: ProcessedAttachment[] = [];

  for (const attachment of attachments) {
    try {
      let content = '';

      if (attachment.file_type === 'pdf') {
        content = await extractPdfText(attachment.file_url);
      } else if (attachment.file_type === 'image') {
        content = await describeImage(attachment.file_url, projectId);
      } else if (attachment.file_type === 'spreadsheet') {
        content = await extractSpreadsheetData(attachment.file_url);
      } else {
        content = await extractTextFile(attachment.file_url);
      }

      if (content) {
        results.push({ fileName: attachment.file_name, fileType: attachment.file_type, content });
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

async function extractPdfText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch PDF: ${response.status}`);

  const buffer = Buffer.from(await response.arrayBuffer());

  try {
    const pdfParse = (await import('pdf-parse')).default;
    const data = await pdfParse(buffer);
    return data.text || '';
  } catch (err) {
    throw new Error(`PDF parsing failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function describeImage(url: string, projectId: string): Promise<string> {
  return analyzeImage(
    url,
    'Describe this image in detail. If it is a logo, describe the design, colors, and style. If it is a screenshot or mockup, describe the layout, sections, content, colors, fonts, and notable design elements. If it is a brand manual page, extract all brand guidelines, colors, fonts, and rules.',
    projectId
  );
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
