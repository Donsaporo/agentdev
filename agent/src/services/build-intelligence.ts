import type { GeneratedFile, ArchitecturePage } from '../core/types.js';
import { selectFilesWithinBudget } from '../core/token-counter.js';

export interface ExportSignature {
  path: string;
  defaultExport: string | null;
  namedExports: string[];
}

export function extractExportSignatures(files: GeneratedFile[]): ExportSignature[] {
  const signatures: ExportSignature[] = [];

  for (const file of files) {
    if (!/\.(tsx?|jsx?)$/.test(file.path)) continue;

    let defaultExport: string | null = null;
    const namedExports: string[] = [];

    const defaultPatterns = [
      /export\s+default\s+(?:function|class|const|let|var)\s+(\w+)/,
      /export\s+default\s+(?:React\.)?memo\s*\(\s*(?:function\s+)?(\w+)/,
      /export\s+default\s+(?:React\.)?forwardRef\s*[(<]\s*(?:function\s+)?(\w+)/,
    ];
    for (const pattern of defaultPatterns) {
      const m = file.content.match(pattern);
      if (m) {
        defaultExport = m[1];
        break;
      }
    }
    if (!defaultExport && file.content.includes('export default')) {
      const standaloneDefault = file.content.match(/export\s+default\s+(\w+)\s*;/);
      if (standaloneDefault) {
        defaultExport = standaloneDefault[1];
      } else {
        defaultExport = 'default';
      }
    }

    const namedMatches = file.content.matchAll(
      /export\s+(?:function|const|let|var|class|interface|type|enum|abstract\s+class)\s+(\w+)/g
    );
    for (const match of namedMatches) {
      if (match[1] !== defaultExport) {
        namedExports.push(match[1]);
      }
    }

    const reExportMatches = file.content.matchAll(
      /export\s*\{\s*([^}]+)\s*\}/g
    );
    for (const match of reExportMatches) {
      const names = match[1].split(',').map((n) => {
        const trimmed = n.trim();
        const asMatch = trimmed.match(/(\w+)\s+as\s+(\w+)/);
        return asMatch ? asMatch[2] : trimmed;
      }).filter((n) => n && n !== 'default' && n !== defaultExport);
      namedExports.push(...names);
    }

    if (defaultExport || namedExports.length > 0) {
      signatures.push({ path: file.path, defaultExport, namedExports });
    }
  }

  return signatures;
}

export function buildExportContext(signatures: ExportSignature[]): string {
  if (signatures.length === 0) return '';

  const lines: string[] = [
    'ALREADY-BUILT MODULE EXPORTS (use these exact paths when importing):',
  ];

  for (const sig of signatures) {
    const parts: string[] = [];
    if (sig.defaultExport) {
      parts.push(`default: ${sig.defaultExport}`);
    }
    if (sig.namedExports.length > 0) {
      parts.push(`{ ${sig.namedExports.join(', ')} }`);
    }
    lines.push(`  ${sig.path} -> ${parts.join(', ')}`);
  }

  return lines.join('\n');
}

export function deduplicateErrors(errors: string[]): string[] {
  const rootCauses = new Map<string, { representative: string; count: number; files: Set<string> }>();

  for (const error of errors) {
    const fileInError = error.match(/(src\/[^\s:'",()+]+)/)?.[1] || '';

    const missingModule = error.match(/(?:Cannot find module|Failed to resolve|Could not resolve)\s+'([^']+)'/);
    if (missingModule) {
      const key = `missing:${missingModule[1]}`;
      const existing = rootCauses.get(key);
      if (existing) {
        existing.count++;
        if (fileInError) existing.files.add(fileInError);
      } else {
        rootCauses.set(key, { representative: error, count: 1, files: new Set(fileInError ? [fileInError] : []) });
      }
      continue;
    }

    const noExport = error.match(/has no exported member '([^']+)'/);
    if (noExport) {
      const sourceFile = error.match(/['"]([^'"]+)['"]\s*has no exported/)?.[1] || '';
      const key = `no-export:${noExport[1]}:${sourceFile}`;
      const existing = rootCauses.get(key);
      if (existing) { existing.count++; if (fileInError) existing.files.add(fileInError); }
      else rootCauses.set(key, { representative: error, count: 1, files: new Set(fileInError ? [fileInError] : []) });
      continue;
    }

    const noProp = error.match(/Property '([^']+)' does not exist on type '([^']+)'/);
    if (noProp) {
      const key = `no-prop:${noProp[1]}:${noProp[2]}`;
      const existing = rootCauses.get(key);
      if (existing) { existing.count++; if (fileInError) existing.files.add(fileInError); }
      else rootCauses.set(key, { representative: error, count: 1, files: new Set(fileInError ? [fileInError] : []) });
      continue;
    }

    const notAssignable = error.match(/is not assignable to type '([^']+)'/);
    if (notAssignable) {
      const key = `not-assignable:${notAssignable[1]}`;
      const existing = rootCauses.get(key);
      if (existing) { existing.count++; if (fileInError) existing.files.add(fileInError); }
      else rootCauses.set(key, { representative: error, count: 1, files: new Set(fileInError ? [fileInError] : []) });
      continue;
    }

    const noDefault = error.match(/has no default export/);
    if (noDefault) {
      const targetFile = error.match(/['"]([^'"]+)['"]\s*has no default/)?.[1] || fileInError;
      const key = `no-default:${targetFile}`;
      const existing = rootCauses.get(key);
      if (existing) { existing.count++; if (fileInError) existing.files.add(fileInError); }
      else rootCauses.set(key, { representative: error, count: 1, files: new Set(fileInError ? [fileInError] : []) });
      continue;
    }

    const normalized = error
      .replace(/src\/[^\s:]+/g, 'FILE')
      .replace(/\(\d+,\d+\)/g, '(N,N)')
      .replace(/line \d+/gi, 'line N');
    if (!rootCauses.has(normalized)) {
      rootCauses.set(normalized, { representative: error, count: 1, files: new Set(fileInError ? [fileInError] : []) });
    } else {
      rootCauses.get(normalized)!.count++;
    }
  }

  return Array.from(rootCauses.values()).map((v) => {
    if (v.count > 1 && v.files.size > 0) {
      return `${v.representative} [repeated ${v.count}x in: ${Array.from(v.files).slice(0, 5).join(', ')}${v.files.size > 5 ? ` +${v.files.size - 5} more` : ''}]`;
    }
    return v.representative;
  });
}

export function filterRelevantFiles(
  allFiles: { path: string; content: string }[],
  errors: string[],
  maxTokens: number = 80_000
): { path: string; content: string }[] {
  const CORE_PATTERNS = [
    'package.json', 'tsconfig', 'vite.config', 'tailwind.config',
    'app.tsx', 'main.tsx', 'index.css',
    'lib/supabase', 'lib/types', 'lib/api',
    'contexts/auth',
  ];

  const relevantPaths = new Set<string>();

  for (const file of allFiles) {
    const lower = file.path.toLowerCase();
    if (CORE_PATTERNS.some((p) => lower.includes(p))) {
      relevantPaths.add(file.path);
    }
  }

  const errorPaths = new Set<string>();
  for (const error of errors) {
    const fileMatches = error.matchAll(/(src\/[^\s:'",()+]+)/g);
    for (const match of fileMatches) {
      const p = match[1].replace(/[,;)]+$/, '');
      errorPaths.add(p);
      errorPaths.add(p.replace(/\.(tsx?|jsx?)$/, ''));
    }

    const moduleMatch = error.match(/['"]\.\/([^'"]+)['"]/);
    if (moduleMatch) {
      errorPaths.add(`src/${moduleMatch[1]}`);
      errorPaths.add(`src/${moduleMatch[1]}.tsx`);
      errorPaths.add(`src/${moduleMatch[1]}.ts`);
    }
  }

  for (const file of allFiles) {
    const fileLower = file.path.toLowerCase();
    const fileNoExt = fileLower.replace(/\.(tsx?|jsx?)$/, '');

    for (const ep of errorPaths) {
      const epLower = ep.toLowerCase();
      const epNoExt = epLower.replace(/\.(tsx?|jsx?)$/, '');

      if (
        fileLower === epLower ||
        fileNoExt === epNoExt ||
        fileLower.endsWith(epLower) ||
        epLower.endsWith(fileLower.replace('src/', ''))
      ) {
        relevantPaths.add(file.path);
        break;
      }
    }
  }

  const relevantArray = Array.from(relevantPaths);
  for (const file of allFiles) {
    if (relevantPaths.has(file.path)) continue;
    for (const rp of relevantArray) {
      const rpBase = rp.replace(/\.(tsx?|jsx?)$/, '').replace('src/', '');
      if (file.content.includes(rpBase)) {
        relevantPaths.add(file.path);
        break;
      }
    }
  }

  const filtered = allFiles.filter((f) => relevantPaths.has(f.path));

  if (filtered.length < 5) {
    return selectFilesWithinBudget(allFiles, maxTokens, [
      'package.json', 'app.tsx', 'main.tsx', 'lib/types', 'lib/api',
    ]);
  }

  return selectFilesWithinBudget(filtered, maxTokens, [
    'package.json', 'app.tsx', 'main.tsx', 'lib/types',
  ]);
}

interface MatchedRoute {
  componentName: string;
  importPath: string;
  route: string;
  hasDefaultExport: boolean;
}

function fileHasDefaultExport(content: string): boolean {
  return /export\s+default\s+/.test(content) || /export\s*\{\s*[^}]*\bdefault\b/.test(content);
}

function matchPagesToFiles(
  pages: ArchitecturePage[],
  fileMap: Map<string, string>,
  fileContents?: Map<string, string>
): MatchedRoute[] {
  const results: MatchedRoute[] = [];
  const usedComponents = new Set<string>();

  for (const page of pages) {
    const normalizedName = page.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    let matchedFile: string | null = null;

    if (fileMap.has(normalizedName)) {
      matchedFile = fileMap.get(normalizedName)!;
    } else {
      for (const [key, fp] of fileMap) {
        if (key.includes(normalizedName) || normalizedName.includes(key)) {
          matchedFile = fp;
          break;
        }
      }
    }

    if (!matchedFile) continue;

    let componentName = page.name.replace(/[^a-zA-Z0-9]/g, '');
    if (!componentName || /^\d/.test(componentName)) {
      componentName = 'Page' + (componentName || 'Unknown');
    }
    if (usedComponents.has(componentName)) continue;
    usedComponents.add(componentName);

    const importPath = './' + matchedFile.replace('src/', '').replace(/\.tsx$/, '');
    const content = fileContents?.get(matchedFile);
    const hasDefaultExport = content ? fileHasDefaultExport(content) : true;
    results.push({ componentName, importPath, route: page.route, hasDefaultExport });
  }

  return results;
}

function buildImportStatement(r: MatchedRoute): string {
  return r.hasDefaultExport
    ? `import ${r.componentName} from '${r.importPath}';`
    : `import { ${r.componentName} } from '${r.importPath}';`;
}

function buildFreshApp(matched: MatchedRoute[]): GeneratedFile {
  const imports = matched.map((r) => buildImportStatement(r)).join('\n');
  const routes = matched.map(
    (r) => `      <Route path="${r.route}" element={<${r.componentName} />} />`
  ).join('\n');

  return {
    path: 'src/App.tsx',
    content: `import { Routes, Route } from 'react-router-dom';
${imports}

export default function App() {
  return (
    <Routes>
${routes}
    </Routes>
  );
}`,
  };
}

export function reconcileAppRoutes(
  allFilePaths: string[],
  pages: ArchitecturePage[],
  existingAppContent?: string,
  fileContents?: Map<string, string>
): GeneratedFile | null {
  const pageFiles = allFilePaths.filter(
    (f) => f.startsWith('src/pages/') && f.endsWith('.tsx')
  );

  if (pageFiles.length === 0) return null;

  const fileMap = new Map<string, string>();
  for (const fp of pageFiles) {
    const name = fp
      .replace('src/pages/', '')
      .replace(/\.tsx$/, '')
      .replace(/[^a-zA-Z0-9]/g, '');
    fileMap.set(name.toLowerCase(), fp);
  }

  const matched = matchPagesToFiles(pages, fileMap, fileContents);
  if (matched.length === 0) return null;

  if (!existingAppContent || !existingAppContent.includes('<Routes')) {
    return buildFreshApp(matched);
  }

  const lines = existingAppContent.split('\n');
  const outputLines: string[] = [];
  const pageImportRegex = /^import\s+(?:\{?\s*)?(\w+)(?:\s*\}?)?\s+from\s+['"]\.\/pages\//;
  const routesCloseRegex = /^(\s*)<\/Routes>/;
  const correctedImportMap = new Map<string, string>();
  const importedComponents = new Set<string>();

  for (const r of matched) {
    correctedImportMap.set(
      r.componentName.toLowerCase(),
      buildImportStatement(r)
    );
  }

  let lastImportLineIdx = -1;
  let routeIndent = '          ';
  let addedMissingRoutes = false;

  for (const line of lines) {
    const pageMatch = line.match(pageImportRegex);

    if (pageMatch) {
      const componentName = pageMatch[1];
      const normalized = componentName.toLowerCase();
      importedComponents.add(normalized);

      if (correctedImportMap.has(normalized)) {
        outputLines.push(correctedImportMap.get(normalized)!);
      } else {
        const importPathMatch = line.match(/from\s+['"](\.[^'"]+)['"]/);
        if (importPathMatch) {
          const resolved = 'src' + importPathMatch[1].slice(1);
          const withExt = resolved.endsWith('.tsx') ? resolved : resolved + '.tsx';
          const exists = allFilePaths.includes(withExt) || allFilePaths.includes(resolved);
          if (exists) {
            outputLines.push(line);
          }
        }
      }
      lastImportLineIdx = outputLines.length - 1;
      continue;
    }

    if (line.trimStart().startsWith('import ')) {
      lastImportLineIdx = outputLines.length;
    }

    const routeMatch = line.match(/^(\s*)<Route\s/);
    if (routeMatch) {
      routeIndent = routeMatch[1];
    }

    const closingMatch = line.match(routesCloseRegex);
    if (closingMatch && !addedMissingRoutes) {
      for (const r of matched) {
        if (!importedComponents.has(r.componentName.toLowerCase())) {
          outputLines.push(
            `${routeIndent}<Route path="${r.route}" element={<${r.componentName} />} />`
          );
        }
      }
      addedMissingRoutes = true;
    }

    outputLines.push(line);
  }

  const missingImports = matched.filter(
    (r) => !importedComponents.has(r.componentName.toLowerCase())
  );

  if (missingImports.length > 0 && lastImportLineIdx >= 0) {
    const newImportLines = missingImports.map((r) => buildImportStatement(r));
    outputLines.splice(lastImportLineIdx + 1, 0, ...newImportLines);
  }

  return { path: 'src/App.tsx', content: outputLines.join('\n') };
}

export function resolveStubPaths(
  pages: ArchitecturePage[],
  allFilePaths: string[]
): string {
  const pageFiles = allFilePaths.filter(
    (f) => f.startsWith('src/pages/') && f.endsWith('.tsx')
  );

  const fileMap = new Map<string, string>();
  for (const fp of pageFiles) {
    const name = fp
      .replace('src/pages/', '')
      .replace(/\.tsx$/, '')
      .replace(/[^a-zA-Z0-9]/g, '');
    fileMap.set(name.toLowerCase(), fp);
  }

  return pages
    .map((page) => {
      const normalized = page.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      const existingPath = fileMap.get(normalized);
      const targetPath = existingPath || `src/pages/${page.name.replace(/[^a-zA-Z0-9]/g, '')}.tsx`;
      return `  ${page.name} -> ${targetPath}`;
    })
    .join('\n');
}

export function validateModuleImports(
  files: GeneratedFile[],
  allFilePaths: string[]
): { stubs: GeneratedFile[]; warnings: string[] } {
  const stubs: GeneratedFile[] = [];
  const warnings: string[] = [];
  const newFilePaths = new Set(files.map((f) => f.path));

  const allKnownPaths = new Set([
    ...allFilePaths,
    ...newFilePaths,
  ]);

  for (const file of files) {
    if (!/\.(tsx?|jsx?)$/.test(file.path)) continue;

    const importRegex = /(?:import|from)\s+['"](@\/[^'"]+|\.\.?\/[^'"]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = importRegex.exec(file.content)) !== null) {
      const importPath = match[1];
      const fileDir = file.path.substring(0, file.path.lastIndexOf('/'));
      let resolved = '';

      if (importPath.startsWith('@/')) {
        resolved = 'src/' + importPath.slice(2);
      } else if (importPath.startsWith('./') || importPath.startsWith('../')) {
        const parts = fileDir.split('/');
        const importParts = importPath.split('/');
        const baseParts = [...parts];
        for (const part of importParts) {
          if (part === '.') continue;
          else if (part === '..') baseParts.pop();
          else baseParts.push(part);
        }
        resolved = baseParts.join('/');
      }

      if (!resolved) continue;

      const candidates = [
        resolved,
        resolved + '.tsx',
        resolved + '.ts',
        resolved + '.jsx',
        resolved + '.js',
        resolved + '/index.tsx',
        resolved + '/index.ts',
      ];

      const found = candidates.some((c) => allKnownPaths.has(c));
      if (!found) {
        warnings.push(`${file.path}: import '${importPath}' resolves to nothing`);

        const stubPath = resolved.endsWith('.tsx') || resolved.endsWith('.ts')
          ? resolved
          : resolved + '.tsx';

        if (!allKnownPaths.has(stubPath) && !stubs.some((s) => s.path === stubPath)) {
          const isNonJsx = stubPath.includes('/lib/') || stubPath.includes('/utils/') ||
            stubPath.includes('/hooks/') || stubPath.includes('/services/') ||
            stubPath.includes('/types') || stubPath.endsWith('.ts');
          const finalPath = isNonJsx && stubPath.endsWith('.tsx') ? stubPath.replace(/\.tsx$/, '.ts') : stubPath;

          stubs.push({
            path: finalPath,
            content: generateSmartStubContent(finalPath),
          });
          allKnownPaths.add(stubPath);
          allKnownPaths.add(finalPath);
        }
      }
    }
  }

  return { stubs, warnings };
}

export function rewriteAliasImports(files: GeneratedFile[]): GeneratedFile[] {
  return files.map((file) => {
    if (!/\.(tsx?|jsx?)$/.test(file.path)) return file;

    const fileDir = file.path.substring(0, file.path.lastIndexOf('/')) || 'src';
    const content = file.content.replace(
      /((?:import|from)\s+['"])@\/([^'"]+)(['"])/g,
      (_full, prefix, aliasPath, suffix) => {
        const targetParts = ('src/' + aliasPath).split('/');
        const fromParts = fileDir.split('/');
        let common = 0;
        while (common < fromParts.length && common < targetParts.length && fromParts[common] === targetParts[common]) {
          common++;
        }
        const ups = fromParts.length - common;
        const remaining = targetParts.slice(common);
        let relativePath: string;
        if (ups > 0) {
          relativePath = Array(ups).fill('..').concat(remaining).join('/');
        } else if (remaining.length > 0) {
          relativePath = './' + remaining.join('/');
        } else {
          relativePath = './index';
        }
        return prefix + relativePath + suffix;
      }
    );
    return content !== file.content ? { ...file, content } : file;
  });
}

function generateSmartStubContent(stubPath: string): string {
  const lower = stubPath.toLowerCase();
  const baseName = stubPath
    .replace(/^src\//, '')
    .replace(/\.(tsx?|jsx?)$/, '')
    .split('/')
    .pop()
    ?.replace(/[^a-zA-Z0-9]/g, '') || 'Placeholder';
  const safeName = (!baseName || /^\d/.test(baseName)) ? 'Page' + baseName : baseName;

  if (lower.includes('/lib/types') || lower.includes('/types/') || lower.includes('/types.ts')) {
    return `export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];
export interface Placeholder { id: string; created_at: string; }`;
  }

  if (lower.includes('/lib/supabase') || lower.includes('/supabase.ts')) {
    return `import { createClient } from '@supabase/supabase-js';
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL || 'https://placeholder.supabase.co',
  import.meta.env.VITE_SUPABASE_ANON_KEY || 'placeholder-key'
);`;
  }

  if (lower.includes('/lib/api') || lower.includes('/services/') || lower.includes('/api.ts')) {
    return `import { supabase } from './supabase';
export async function fetchData(table: string) {
  const { data, error } = await supabase.from(table).select('*');
  if (error) throw error;
  return data;
}`;
  }

  if (lower.includes('/lib/mock-data') || lower.includes('/mock')) {
    return `export const mockData: Record<string, unknown[]> = {};`;
  }

  if (lower.includes('/lib/') || lower.includes('/utils/') || lower.includes('/helpers/')) {
    return `export const placeholder = {};
export type PlaceholderType = Record<string, unknown>;`;
  }

  if (lower.includes('/hooks/')) {
    const hookName = 'use' + safeName.replace(/^use/i, '').charAt(0).toUpperCase() + safeName.replace(/^use/i, '').slice(1);
    return `export function ${hookName}() {
  return { data: null, loading: false, error: null };
}
export default ${hookName};`;
  }

  if (lower.includes('/contexts/')) {
    const ctxName = safeName.charAt(0).toUpperCase() + safeName.slice(1);
    return `import { createContext, useContext, type ReactNode } from 'react';
const ${ctxName}Ctx = createContext<Record<string, unknown>>({});
export function ${ctxName}Provider({ children }: { children: ReactNode }) {
  return <${ctxName}Ctx.Provider value={{}}>{children}</${ctxName}Ctx.Provider>;
}
export function use${ctxName}() { return useContext(${ctxName}Ctx); }
export { ${ctxName}Ctx as ${ctxName} };`;
  }

  const componentName = safeName.charAt(0).toUpperCase() + safeName.slice(1);
  return `export default function ${componentName}() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-2xl font-bold mb-4">${componentName}</h1>
        <p className="text-gray-500">This page is under construction.</p>
      </div>
    </div>
  );
}`;
}

// lucide-react v0.344.0 complete icon set
const VALID_LUCIDE_ICONS = new Set([
  'AArrowDown', 'AArrowUp', 'ALargeSmall', 'Accessibility', 'Activity', 'ActivitySquare',
  'AirVent', 'Airplay', 'AlarmClock', 'AlarmClockCheck', 'AlarmClockMinus', 'AlarmClockOff',
  'AlarmClockPlus', 'AlarmSmoke', 'Album', 'AlertCircle', 'AlertOctagon', 'AlertTriangle',
  'AlignCenter', 'AlignCenterHorizontal', 'AlignCenterVertical', 'AlignEndHorizontal',
  'AlignEndVertical', 'AlignHorizontalDistributeCenter', 'AlignHorizontalDistributeEnd',
  'AlignHorizontalDistributeStart', 'AlignHorizontalJustifyCenter', 'AlignHorizontalJustifyEnd',
  'AlignHorizontalJustifyStart', 'AlignHorizontalSpaceAround', 'AlignHorizontalSpaceBetween',
  'AlignJustify', 'AlignLeft', 'AlignRight', 'AlignStartHorizontal', 'AlignStartVertical',
  'AlignVerticalDistributeCenter', 'AlignVerticalDistributeEnd', 'AlignVerticalDistributeStart',
  'AlignVerticalJustifyCenter', 'AlignVerticalJustifyEnd', 'AlignVerticalJustifyStart',
  'AlignVerticalSpaceAround', 'AlignVerticalSpaceBetween', 'Ambulance', 'Ampersand',
  'Ampersands', 'Anchor', 'Angry', 'Annoyed', 'Antenna', 'Anvil', 'Aperture', 'AppWindow',
  'Apple', 'Archive', 'ArchiveRestore', 'ArchiveX', 'AreaChart', 'Armchair',
  'ArrowBigDown', 'ArrowBigDownDash', 'ArrowBigLeft', 'ArrowBigLeftDash', 'ArrowBigRight',
  'ArrowBigRightDash', 'ArrowBigUp', 'ArrowBigUpDash', 'ArrowDown', 'ArrowDown01',
  'ArrowDown10', 'ArrowDownAZ', 'ArrowDownCircle', 'ArrowDownFromLine', 'ArrowDownLeft',
  'ArrowDownLeftFromCircle', 'ArrowDownLeftFromSquare', 'ArrowDownLeftSquare',
  'ArrowDownNarrowWide', 'ArrowDownRight', 'ArrowDownRightFromCircle',
  'ArrowDownRightFromSquare', 'ArrowDownRightSquare', 'ArrowDownSquare', 'ArrowDownToDot',
  'ArrowDownToLine', 'ArrowDownUp', 'ArrowDownWideNarrow', 'ArrowDownZA', 'ArrowLeft',
  'ArrowLeftCircle', 'ArrowLeftFromLine', 'ArrowLeftRight', 'ArrowLeftSquare',
  'ArrowLeftToLine', 'ArrowRight', 'ArrowRightCircle', 'ArrowRightFromLine',
  'ArrowRightLeft', 'ArrowRightSquare', 'ArrowRightToLine', 'ArrowUp', 'ArrowUp01',
  'ArrowUp10', 'ArrowUpAZ', 'ArrowUpCircle', 'ArrowUpDown', 'ArrowUpFromDot',
  'ArrowUpFromLine', 'ArrowUpLeft', 'ArrowUpLeftFromCircle', 'ArrowUpLeftFromSquare',
  'ArrowUpLeftSquare', 'ArrowUpNarrowWide', 'ArrowUpRight', 'ArrowUpRightFromCircle',
  'ArrowUpRightFromSquare', 'ArrowUpRightSquare', 'ArrowUpSquare', 'ArrowUpToLine',
  'ArrowUpWideNarrow', 'ArrowUpZA', 'ArrowsUpFromLine', 'Asterisk', 'AsteriskSquare',
  'AtSign', 'Atom', 'AudioLines', 'AudioWaveform', 'Award', 'Axe', 'Axis3d',
  'Baby', 'Backpack', 'Badge', 'BadgeAlert', 'BadgeCent', 'BadgeCheck', 'BadgeDollarSign',
  'BadgeEuro', 'BadgeHelp', 'BadgeIndianRupee', 'BadgeInfo', 'BadgeJapaneseYen',
  'BadgeMinus', 'BadgePercent', 'BadgePlus', 'BadgePoundSterling', 'BadgeRussianRuble',
  'BadgeSwissFranc', 'BadgeX', 'BaggageClaim', 'Ban', 'Banana', 'Banknote',
  'BarChart', 'BarChart2', 'BarChart3', 'BarChart4', 'BarChartBig', 'BarChartHorizontal',
  'BarChartHorizontalBig', 'Barcode', 'Baseline', 'Bath', 'Battery', 'BatteryCharging',
  'BatteryFull', 'BatteryLow', 'BatteryMedium', 'BatteryWarning', 'Beaker', 'Bean',
  'BeanOff', 'Bed', 'BedDouble', 'BedSingle', 'Beef', 'Beer', 'Bell', 'BellDot',
  'BellElectric', 'BellMinus', 'BellOff', 'BellPlus', 'BellRing', 'BetweenHorizontalEnd',
  'BetweenHorizontalStart', 'BetweenVerticalEnd', 'BetweenVerticalStart', 'Bike', 'Binary',
  'Biohazard', 'Bird', 'Bitcoin', 'Blend', 'Blinds', 'Blocks', 'Bluetooth',
  'BluetoothConnected', 'BluetoothOff', 'BluetoothSearching', 'Bold', 'Bolt', 'Bomb',
  'Bone', 'Book', 'BookA', 'BookAudio', 'BookCheck', 'BookCopy', 'BookDashed', 'BookDown',
  'BookHeadphones', 'BookHeart', 'BookImage', 'BookKey', 'BookLock', 'BookMarked',
  'BookMinus', 'BookOpen', 'BookOpenCheck', 'BookOpenText', 'BookPlus', 'BookText',
  'BookType', 'BookUp', 'BookUp2', 'BookUser', 'BookX', 'Bookmark', 'BookmarkCheck',
  'BookmarkMinus', 'BookmarkPlus', 'BookmarkX', 'BoomBox', 'Bot', 'BotMessageSquare',
  'Box', 'BoxSelect', 'Boxes', 'Braces', 'Brackets', 'Brain', 'BrainCircuit', 'BrainCog',
  'BrickWall', 'Briefcase', 'BringToFront', 'Brush', 'Bug', 'BugOff', 'BugPlay',
  'Building', 'Building2', 'Bus', 'BusFront', 'Cable', 'CableCar', 'Cake', 'CakeSlice',
  'Calculator', 'Calendar', 'CalendarCheck', 'CalendarCheck2', 'CalendarClock',
  'CalendarDays', 'CalendarFold', 'CalendarHeart', 'CalendarMinus', 'CalendarMinus2',
  'CalendarOff', 'CalendarPlus', 'CalendarPlus2', 'CalendarRange', 'CalendarSearch',
  'CalendarX', 'CalendarX2', 'Camera', 'CameraOff', 'CandlestickChart', 'Candy',
  'CandyCane', 'CandyOff', 'Captions', 'CaptionsOff', 'Car', 'CarFront', 'CarTaxiFront',
  'Caravan', 'Carrot', 'CaseLower', 'CaseSensitive', 'CaseUpper', 'CassetteTape', 'Cast',
  'Castle', 'Cat', 'Cctv', 'Check', 'CheckCheck', 'CheckCircle', 'CheckCircle2',
  'CheckSquare', 'CheckSquare2', 'ChefHat', 'Cherry', 'ChevronDown', 'ChevronDownCircle',
  'ChevronDownSquare', 'ChevronFirst', 'ChevronLast', 'ChevronLeft', 'ChevronLeftCircle',
  'ChevronLeftSquare', 'ChevronRight', 'ChevronRightCircle', 'ChevronRightSquare',
  'ChevronUp', 'ChevronUpCircle', 'ChevronUpSquare', 'ChevronsDown', 'ChevronsDownUp',
  'ChevronsLeft', 'ChevronsLeftRight', 'ChevronsRight', 'ChevronsRightLeft', 'ChevronsUp',
  'ChevronsUpDown', 'Chrome', 'Church', 'Cigarette', 'CigaretteOff', 'Circle',
  'CircleDashed', 'CircleDollarSign', 'CircleDot', 'CircleDotDashed', 'CircleEllipsis',
  'CircleEqual', 'CircleFadingPlus', 'CircleOff', 'CircleSlash', 'CircleSlash2',
  'CircleUser', 'CircleUserRound', 'CircuitBoard', 'Citrus', 'Clapperboard', 'Clipboard',
  'ClipboardCheck', 'ClipboardCopy', 'ClipboardList', 'ClipboardMinus', 'ClipboardPaste',
  'ClipboardPen', 'ClipboardPenLine', 'ClipboardPlus', 'ClipboardType', 'ClipboardX',
  'Clock', 'Clock1', 'Clock10', 'Clock11', 'Clock12', 'Clock2', 'Clock3', 'Clock4',
  'Clock5', 'Clock6', 'Clock7', 'Clock8', 'Clock9', 'Cloud', 'CloudCog', 'CloudDrizzle',
  'CloudFog', 'CloudHail', 'CloudLightning', 'CloudMoon', 'CloudMoonRain', 'CloudOff',
  'CloudRain', 'CloudRainWind', 'CloudSnow', 'CloudSun', 'CloudSunRain', 'Cloudy',
  'Clover', 'Club', 'Code', 'Code2', 'CodeSquare', 'Codepen', 'Codesandbox', 'Coffee',
  'Cog', 'Coins', 'Columns2', 'Columns3', 'Columns4', 'Combine', 'Command', 'Compass',
  'Component', 'Computer', 'ConciergeBell', 'Cone', 'Construction', 'Contact', 'Contact2',
  'Container', 'Contrast', 'Cookie', 'CookingPot', 'Copy', 'CopyCheck', 'CopyMinus',
  'CopyPlus', 'CopySlash', 'CopyX', 'Copyleft', 'Copyright', 'CornerDownLeft',
  'CornerDownRight', 'CornerLeftDown', 'CornerLeftUp', 'CornerRightDown', 'CornerRightUp',
  'CornerUpLeft', 'CornerUpRight', 'Cpu', 'CreativeCommons', 'CreditCard', 'Croissant',
  'Crop', 'Cross', 'Crosshair', 'Crown', 'Cuboid', 'CupSoda', 'Currency', 'Cylinder',
  'Database', 'DatabaseBackup', 'DatabaseZap', 'Delete', 'Dessert', 'Diameter', 'Diamond',
  'Dice1', 'Dice2', 'Dice3', 'Dice4', 'Dice5', 'Dice6', 'Dices', 'Diff', 'Disc',
  'Disc2', 'Disc3', 'DiscAlbum', 'Divide', 'DivideCircle', 'DivideSquare', 'Dna',
  'DnaOff', 'Dog', 'DollarSign', 'Donut', 'DoorClosed', 'DoorOpen', 'Dot', 'DotSquare',
  'Download', 'DownloadCloud', 'DraftingCompass', 'Drama', 'Dribbble', 'Drill', 'Droplet',
  'Droplets', 'Drum', 'Drumstick', 'Dumbbell', 'Ear', 'EarOff', 'Earth', 'EarthLock',
  'Eclipse', 'Egg', 'EggFried', 'EggOff', 'Equal', 'EqualNot', 'EqualSquare', 'Eraser',
  'Euro', 'Expand', 'ExternalLink', 'Eye', 'EyeOff', 'Facebook', 'Factory', 'Fan',
  'FastForward', 'Feather', 'Fence', 'FerrisWheel', 'Figma', 'File', 'FileArchive',
  'FileAudio', 'FileAudio2', 'FileAxis3d', 'FileBadge', 'FileBadge2', 'FileBarChart',
  'FileBarChart2', 'FileBox', 'FileCheck', 'FileCheck2', 'FileClock', 'FileCode',
  'FileCode2', 'FileCog', 'FileDiff', 'FileDigit', 'FileDown', 'FileHeart', 'FileImage',
  'FileInput', 'FileJson', 'FileJson2', 'FileKey', 'FileKey2', 'FileLineChart', 'FileLock',
  'FileLock2', 'FileMinus', 'FileMinus2', 'FileMusic', 'FileOutput', 'FilePen',
  'FilePenLine', 'FilePieChart', 'FilePlus', 'FilePlus2', 'FileQuestion', 'FileScan',
  'FileSearch', 'FileSearch2', 'FileSliders', 'FileSpreadsheet', 'FileStack', 'FileSymlink',
  'FileTerminal', 'FileText', 'FileType', 'FileType2', 'FileUp', 'FileVideo', 'FileVideo2',
  'FileVolume', 'FileVolume2', 'FileWarning', 'FileX', 'FileX2', 'Files', 'Film',
  'Filter', 'FilterX', 'Fingerprint', 'FireExtinguisher', 'Fish', 'FishOff', 'FishSymbol',
  'Flag', 'FlagOff', 'FlagTriangleLeft', 'FlagTriangleRight', 'Flame', 'FlameKindling',
  'Flashlight', 'FlashlightOff', 'FlaskConical', 'FlaskConicalOff', 'FlaskRound',
  'FlipHorizontal', 'FlipHorizontal2', 'FlipVertical', 'FlipVertical2', 'Flower', 'Flower2',
  'Focus', 'FoldHorizontal', 'FoldVertical', 'Folder', 'FolderArchive', 'FolderCheck',
  'FolderClock', 'FolderClosed', 'FolderCog', 'FolderDot', 'FolderDown', 'FolderGit',
  'FolderGit2', 'FolderHeart', 'FolderInput', 'FolderKanban', 'FolderKey', 'FolderLock',
  'FolderMinus', 'FolderOpen', 'FolderOpenDot', 'FolderOutput', 'FolderPen', 'FolderPlus',
  'FolderRoot', 'FolderSearch', 'FolderSearch2', 'FolderSymlink', 'FolderSync', 'FolderTree',
  'FolderUp', 'FolderX', 'Folders', 'Footprints', 'Forklift', 'FormInput', 'Forward',
  'Frame', 'Framer', 'Frown', 'Fuel', 'Fullscreen', 'FunctionSquare',
  'GalleryHorizontal', 'GalleryHorizontalEnd', 'GalleryThumbnails', 'GalleryVertical',
  'GalleryVerticalEnd', 'Gamepad', 'Gamepad2', 'GanttChart', 'GanttChartSquare', 'Gauge',
  'GaugeCircle', 'Gavel', 'Gem', 'Ghost', 'Gift', 'GitBranch', 'GitBranchPlus',
  'GitCommitHorizontal', 'GitCommitVertical', 'GitCompare', 'GitCompareArrows', 'GitFork',
  'GitGraph', 'GitMerge', 'GitPullRequest', 'GitPullRequestArrow', 'GitPullRequestClosed',
  'GitPullRequestCreate', 'GitPullRequestCreateArrow', 'GitPullRequestDraft', 'Github',
  'Gitlab', 'GlassWater', 'Glasses', 'Globe', 'GlobeLock', 'Goal', 'Grab', 'GraduationCap',
  'Grape', 'Grid2x2', 'Grid3x3', 'Grip', 'GripHorizontal', 'GripVertical', 'Group',
  'Guitar', 'Hammer', 'Hand', 'HandCoins', 'HandHeart', 'HandHelping', 'HandMetal',
  'HandPlatter', 'Handshake', 'HardDrive', 'HardDriveDownload', 'HardDriveUpload', 'HardHat',
  'Hash', 'Haze', 'HdmiPort', 'Heading', 'Heading1', 'Heading2', 'Heading3', 'Heading4',
  'Heading5', 'Heading6', 'Headphones', 'Headset', 'Heart', 'HeartCrack', 'HeartHandshake',
  'HeartOff', 'HeartPulse', 'Heater', 'HelpCircle', 'Hexagon', 'Highlighter', 'History',
  'Home', 'Hop', 'HopOff', 'Hotel', 'Hourglass', 'IceCream', 'IceCream2', 'Image',
  'ImageDown', 'ImageMinus', 'ImageOff', 'ImagePlus', 'ImageUp', 'Images', 'Import',
  'Inbox', 'Indent', 'IndianRupee', 'Infinity', 'Info', 'InspectionPanel', 'Instagram',
  'Italic', 'IterationCcw', 'IterationCw', 'JapaneseYen', 'Joystick', 'Kanban',
  'KanbanSquare', 'KanbanSquareDashed', 'Key', 'KeyRound', 'KeySquare', 'Keyboard',
  'KeyboardMusic', 'Lamp', 'LampCeiling', 'LampDesk', 'LampFloor', 'LampWallDown',
  'LampWallUp', 'LandPlot', 'Landmark', 'Languages', 'Laptop', 'Laptop2', 'Lasso',
  'LassoSelect', 'Laugh', 'Layers2', 'Layers3', 'LayoutDashboard', 'LayoutGrid',
  'LayoutList', 'LayoutPanelLeft', 'LayoutPanelTop', 'LayoutTemplate', 'Leaf', 'LeafyGreen',
  'Library', 'LibraryBig', 'LibrarySquare', 'LifeBuoy', 'Ligature', 'Lightbulb',
  'LightbulbOff', 'LineChart', 'Link', 'Link2', 'Link2Off', 'Linkedin', 'List',
  'ListChecks', 'ListCollapse', 'ListEnd', 'ListFilter', 'ListMinus', 'ListMusic',
  'ListOrdered', 'ListPlus', 'ListRestart', 'ListStart', 'ListTodo', 'ListTree', 'ListVideo',
  'ListX', 'Loader', 'Loader2', 'Locate', 'LocateFixed', 'LocateOff', 'Lock',
  'LockKeyhole', 'LogIn', 'LogOut', 'Lollipop', 'Luggage', 'MSquare', 'Magnet', 'Mail',
  'MailCheck', 'MailMinus', 'MailOpen', 'MailPlus', 'MailQuestion', 'MailSearch',
  'MailWarning', 'MailX', 'Mailbox', 'Mails', 'Map', 'MapPin', 'MapPinOff', 'MapPinned',
  'Martini', 'Maximize', 'Maximize2', 'Medal', 'Megaphone', 'MegaphoneOff', 'Meh',
  'MemoryStick', 'Menu', 'MenuSquare', 'Merge', 'MessageCircle', 'MessageCircleCode',
  'MessageCircleDashed', 'MessageCircleHeart', 'MessageCircleMore', 'MessageCircleOff',
  'MessageCirclePlus', 'MessageCircleQuestion', 'MessageCircleReply',
  'MessageCircleWarning', 'MessageCircleX', 'MessageSquare', 'MessageSquareCode',
  'MessageSquareDashed', 'MessageSquareDiff', 'MessageSquareDot', 'MessageSquareHeart',
  'MessageSquareMore', 'MessageSquareOff', 'MessageSquarePlus', 'MessageSquareQuote',
  'MessageSquareReply', 'MessageSquareShare', 'MessageSquareText', 'MessageSquareWarning',
  'MessageSquareX', 'MessagesSquare', 'Mic', 'Mic2', 'MicOff', 'Microscope', 'Microwave',
  'Milestone', 'Milk', 'MilkOff', 'Minimize', 'Minimize2', 'Minus', 'MinusCircle',
  'MinusSquare', 'Monitor', 'MonitorCheck', 'MonitorDot', 'MonitorDown', 'MonitorOff',
  'MonitorPause', 'MonitorPlay', 'MonitorSmartphone', 'MonitorSpeaker', 'MonitorStop',
  'MonitorUp', 'MonitorX', 'Moon', 'MoonStar', 'MoreHorizontal', 'MoreVertical', 'Mountain',
  'MountainSnow', 'Mouse', 'MousePointer', 'MousePointer2', 'MousePointerClick',
  'MousePointerSquare', 'MousePointerSquareDashed', 'Move', 'Move3d', 'MoveDiagonal',
  'MoveDiagonal2', 'MoveDown', 'MoveDownLeft', 'MoveDownRight', 'MoveHorizontal', 'MoveLeft',
  'MoveRight', 'MoveUp', 'MoveUpLeft', 'MoveUpRight', 'MoveVertical', 'Music', 'Music2',
  'Music3', 'Music4', 'Navigation', 'Navigation2', 'Navigation2Off', 'NavigationOff',
  'Network', 'Newspaper', 'Nfc', 'Notebook', 'NotebookPen', 'NotebookTabs', 'NotebookText',
  'NotepadText', 'NotepadTextDashed', 'Nut', 'NutOff', 'Octagon', 'Option', 'Orbit',
  'Outdent', 'Package', 'Package2', 'PackageCheck', 'PackageMinus', 'PackageOpen',
  'PackagePlus', 'PackageSearch', 'PackageX', 'PaintBucket', 'PaintRoller', 'Paintbrush',
  'Paintbrush2', 'Palette', 'Palmtree', 'PanelBottom', 'PanelBottomClose',
  'PanelBottomDashed', 'PanelBottomOpen', 'PanelLeft', 'PanelLeftClose', 'PanelLeftDashed',
  'PanelLeftOpen', 'PanelRight', 'PanelRightClose', 'PanelRightDashed', 'PanelRightOpen',
  'PanelTop', 'PanelTopClose', 'PanelTopDashed', 'PanelTopOpen', 'PanelsLeftBottom',
  'PanelsRightBottom', 'PanelsTopLeft', 'Paperclip', 'Parentheses', 'ParkingCircle',
  'ParkingCircleOff', 'ParkingMeter', 'ParkingSquare', 'ParkingSquareOff', 'PartyPopper',
  'Pause', 'PauseCircle', 'PauseOctagon', 'PawPrint', 'PcCase', 'Pen', 'PenLine', 'PenTool',
  'Pencil', 'PencilLine', 'PencilRuler', 'Pentagon', 'Percent', 'PercentCircle',
  'PercentDiamond', 'PercentSquare', 'PersonStanding', 'Phone', 'PhoneCall',
  'PhoneForwarded', 'PhoneIncoming', 'PhoneMissed', 'PhoneOff', 'PhoneOutgoing', 'Pi',
  'PiSquare', 'Piano', 'Pickaxe', 'PictureInPicture', 'PictureInPicture2', 'PieChart',
  'PiggyBank', 'Pilcrow', 'PilcrowSquare', 'Pill', 'Pin', 'PinOff', 'Pipette', 'Pizza',
  'Plane', 'PlaneLanding', 'PlaneTakeoff', 'Play', 'PlayCircle', 'PlaySquare', 'Plug',
  'Plug2', 'PlugZap', 'PlugZap2', 'Plus', 'PlusCircle', 'PlusSquare', 'Pocket',
  'PocketKnife', 'Podcast', 'Pointer', 'PointerOff', 'Popcorn', 'Popsicle', 'PoundSterling',
  'Power', 'PowerCircle', 'PowerOff', 'PowerSquare', 'Presentation', 'Printer', 'Projector',
  'Puzzle', 'Pyramid', 'QrCode', 'Quote', 'Rabbit', 'Radar', 'Radiation', 'Radical',
  'Radio', 'RadioReceiver', 'RadioTower', 'Radius', 'RailSymbol', 'Rainbow', 'Rat', 'Ratio',
  'Receipt', 'ReceiptCent', 'ReceiptEuro', 'ReceiptIndianRupee', 'ReceiptJapaneseYen',
  'ReceiptPoundSterling', 'ReceiptRussianRuble', 'ReceiptSwissFranc', 'ReceiptText',
  'RectangleHorizontal', 'RectangleVertical', 'Recycle', 'Redo', 'Redo2', 'RedoDot',
  'RefreshCcw', 'RefreshCcwDot', 'RefreshCw', 'RefreshCwOff', 'Refrigerator', 'Regex',
  'RemoveFormatting', 'Repeat', 'Repeat1', 'Repeat2', 'Replace', 'ReplaceAll', 'Reply',
  'ReplyAll', 'Rewind', 'Ribbon', 'Rocket', 'RockingChair', 'RollerCoaster', 'Rotate3d',
  'RotateCcw', 'RotateCw', 'Route', 'RouteOff', 'Router', 'Rows2', 'Rows3', 'Rows4', 'Rss',
  'Ruler', 'RussianRuble', 'Sailboat', 'Salad', 'Sandwich', 'Satellite', 'SatelliteDish',
  'Save', 'SaveAll', 'Scale', 'Scale3d', 'Scaling', 'Scan', 'ScanBarcode', 'ScanEye',
  'ScanFace', 'ScanLine', 'ScanSearch', 'ScanText', 'ScatterChart', 'School', 'School2',
  'Scissors', 'ScissorsLineDashed', 'ScissorsSquare', 'ScissorsSquareDashedBottom',
  'ScreenShare', 'ScreenShareOff', 'Scroll', 'ScrollText', 'Search', 'SearchCheck',
  'SearchCode', 'SearchSlash', 'SearchX', 'Send', 'SendHorizontal', 'SendToBack',
  'SeparatorHorizontal', 'SeparatorVertical', 'Server', 'ServerCog', 'ServerCrash',
  'ServerOff', 'Settings', 'Settings2', 'Shapes', 'Share', 'Share2', 'Sheet', 'Shell',
  'Shield', 'ShieldAlert', 'ShieldBan', 'ShieldCheck', 'ShieldEllipsis', 'ShieldHalf',
  'ShieldMinus', 'ShieldOff', 'ShieldPlus', 'ShieldQuestion', 'ShieldX', 'Ship', 'ShipWheel',
  'Shirt', 'ShoppingBag', 'ShoppingBasket', 'ShoppingCart', 'Shovel', 'ShowerHead', 'Shrink',
  'Shrub', 'Shuffle', 'Sigma', 'SigmaSquare', 'Signal', 'SignalHigh', 'SignalLow',
  'SignalMedium', 'SignalZero', 'Signpost', 'SignpostBig', 'Siren', 'SkipBack', 'SkipForward',
  'Skull', 'Slack', 'Slash', 'SlashSquare', 'Slice', 'Sliders', 'SlidersHorizontal',
  'Smartphone', 'SmartphoneCharging', 'SmartphoneNfc', 'Smile', 'SmilePlus', 'Snail',
  'Snowflake', 'Sofa', 'Soup', 'Space', 'Spade', 'Sparkle', 'Sparkles', 'Speaker', 'Speech',
  'SpellCheck', 'SpellCheck2', 'Spline', 'Split', 'SplitSquareHorizontal',
  'SplitSquareVertical', 'SprayCan', 'Sprout', 'Square', 'SquareDashedBottom',
  'SquareDashedBottomCode', 'SquarePen', 'SquareRadical', 'SquareStack', 'SquareUser',
  'SquareUserRound', 'Squircle', 'Squirrel', 'Stamp', 'Star', 'StarHalf', 'StarOff',
  'StepBack', 'StepForward', 'Stethoscope', 'Sticker', 'StickyNote', 'StopCircle', 'Store',
  'StretchHorizontal', 'StretchVertical', 'Strikethrough', 'Subscript', 'Sun', 'SunDim',
  'SunMedium', 'SunMoon', 'SunSnow', 'Sunrise', 'Sunset', 'Superscript', 'SwatchBook',
  'SwissFranc', 'SwitchCamera', 'Sword', 'Swords', 'Syringe', 'Table', 'Table2',
  'TableCellsMerge', 'TableCellsSplit', 'TableColumnsSplit', 'TableProperties',
  'TableRowsSplit', 'Tablet', 'TabletSmartphone', 'Tablets', 'Tag', 'Tags', 'Tally1',
  'Tally2', 'Tally3', 'Tally4', 'Tally5', 'Tangent', 'Target', 'Telescope', 'Tent',
  'TentTree', 'Terminal', 'TerminalSquare', 'TestTube', 'TestTube2', 'TestTubes', 'Text',
  'TextCursor', 'TextCursorInput', 'TextQuote', 'TextSearch', 'TextSelect', 'Theater',
  'Thermometer', 'ThermometerSnowflake', 'ThermometerSun', 'ThumbsDown', 'ThumbsUp', 'Ticket',
  'TicketCheck', 'TicketMinus', 'TicketPercent', 'TicketPlus', 'TicketSlash', 'TicketX',
  'Timer', 'TimerOff', 'TimerReset', 'ToggleLeft', 'ToggleRight', 'Tornado', 'Torus',
  'Touchpad', 'TouchpadOff', 'TowerControl', 'ToyBrick', 'Tractor', 'TrafficCone',
  'TrainFront', 'TrainFrontTunnel', 'TrainTrack', 'TramFront', 'Trash', 'Trash2',
  'TreeDeciduous', 'TreePine', 'Trees', 'Trello', 'TrendingDown', 'TrendingUp', 'Triangle',
  'TriangleRight', 'Trophy', 'Truck', 'Turtle', 'Tv', 'Tv2', 'Twitch', 'Twitter', 'Type',
  'Umbrella', 'UmbrellaOff', 'Underline', 'Undo', 'Undo2', 'UndoDot', 'UnfoldHorizontal',
  'UnfoldVertical', 'Ungroup', 'Unlink', 'Unlink2', 'Unlock', 'UnlockKeyhole', 'Unplug',
  'Upload', 'UploadCloud', 'Usb', 'User', 'UserCheck', 'UserCog', 'UserMinus', 'UserPlus',
  'UserRound', 'UserRoundCheck', 'UserRoundCog', 'UserRoundMinus', 'UserRoundPlus',
  'UserRoundSearch', 'UserRoundX', 'UserSearch', 'UserX', 'Users', 'UsersRound', 'Utensils',
  'UtensilsCrossed', 'UtilityPole', 'Variable', 'Vault', 'Vegan', 'VenetianMask', 'Vibrate',
  'VibrateOff', 'Video', 'VideoOff', 'Videotape', 'View', 'Voicemail', 'Volume', 'Volume1',
  'Volume2', 'VolumeX', 'Vote', 'Wallet', 'Wallet2', 'WalletCards', 'Wallpaper', 'Wand',
  'Wand2', 'Warehouse', 'WashingMachine', 'Watch', 'Waves', 'Waypoints', 'Webcam', 'Webhook',
  'WebhookOff', 'Weight', 'Wheat', 'WheatOff', 'WholeWord', 'Wifi', 'WifiOff', 'Wind',
  'Wine', 'WineOff', 'Workflow', 'WrapText', 'Wrench', 'X', 'XCircle', 'XOctagon', 'XSquare',
  'Youtube', 'Zap', 'ZapOff', 'ZoomIn', 'ZoomOut',
]);

const LUCIDE_FALLBACK_ICON = 'Circle';

export function sanitizeLucideImports(files: GeneratedFile[]): GeneratedFile[] {
  return files.map((file) => {
    if (!/\.(tsx?|jsx?)$/.test(file.path)) return file;

    const replaced = file.content.replace(
      /import\s*\{([^}]+)\}\s*from\s*['"]lucide-react['"]/g,
      (_match, imports: string) => {
        const icons = imports.split(',').map((s: string) => s.trim()).filter(Boolean);
        const fixed = icons.map((icon: string) => {
          const cleanIcon = icon.replace(/\s+as\s+\w+/, '').trim();
          if (VALID_LUCIDE_ICONS.has(cleanIcon)) return icon;
          const aliasMatch = icon.match(/(\w+)\s+as\s+(\w+)/);
          if (aliasMatch && VALID_LUCIDE_ICONS.has(aliasMatch[1])) return icon;
          return icon.includes(' as ')
            ? `${LUCIDE_FALLBACK_ICON} as ${icon.split(' as ')[1].trim()}`
            : LUCIDE_FALLBACK_ICON;
        });
        const deduped = [...new Set(fixed)];
        return `import { ${deduped.join(', ')} } from 'lucide-react'`;
      }
    );

    return replaced !== file.content ? { ...file, content: replaced } : file;
  });
}

function resolveRelativePath(fromFile: string, importPath: string): string {
  if (importPath.startsWith('@/')) {
    return 'src/' + importPath.slice(2);
  }
  const fromDir = fromFile.substring(0, fromFile.lastIndexOf('/')) || 'src';
  const parts = fromDir.split('/');
  const importParts = importPath.split('/');
  const baseParts = [...parts];
  for (const part of importParts) {
    if (part === '.') continue;
    else if (part === '..') baseParts.pop();
    else baseParts.push(part);
  }
  return baseParts.join('/');
}

export function generateStubForMissingImport(
  error: string,
  allFilePaths: string[]
): GeneratedFile | null {
  const moduleMatch = error.match(
    /(?:Cannot find module|Failed to resolve|Could not resolve)\s+'([^']+)'/
  );
  if (!moduleMatch) return null;

  const rawPath = moduleMatch[1];
  if (!rawPath.startsWith('.') && !rawPath.startsWith('@/')) return null;

  const errorFileMatch = error.match(/(src\/[^\s:'",()+]+)\.(tsx?|jsx?)/);
  const errorFile = errorFileMatch ? `${errorFileMatch[1]}.${errorFileMatch[2]}` : 'src/App.tsx';

  let modulePath: string;
  if (rawPath.startsWith('@/')) {
    modulePath = 'src/' + rawPath.slice(2);
  } else if (rawPath.startsWith('../') || rawPath.startsWith('./')) {
    modulePath = resolveRelativePath(errorFile, rawPath);
  } else {
    modulePath = rawPath.replace(/^\.\//, 'src/');
  }

  if (!modulePath.includes('.')) {
    const isNonJsx = modulePath.includes('/lib/') || modulePath.includes('/utils/') ||
      modulePath.includes('/hooks/') || modulePath.includes('/services/') ||
      modulePath.includes('/types');
    modulePath += isNonJsx ? '.ts' : '.tsx';
  }

  if (allFilePaths.includes(modulePath)) return null;

  return { path: modulePath, content: generateSmartStubContent(modulePath) };
}

export function ensurePageDefaultExports(files: GeneratedFile[]): GeneratedFile[] {
  return files.map((file) => {
    if (!file.path.startsWith('src/pages/') || !file.path.endsWith('.tsx')) return file;

    const hasDefaultExport =
      /export\s+default\s+/.test(file.content) ||
      /export\s*\{\s*[^}]*\bdefault\b/.test(file.content);
    if (hasDefaultExport) return file;

    const namedFnMatch = file.content.match(
      /export\s+(function\s+(\w+))/
    );
    if (namedFnMatch) {
      const fnName = namedFnMatch[2];
      return {
        ...file,
        content: file.content.replace(
          `export function ${fnName}`,
          `export default function ${fnName}`
        ),
      };
    }

    const namedConstMatch = file.content.match(
      /export\s+const\s+(\w+)\s*[=:]/
    );
    if (namedConstMatch) {
      const constName = namedConstMatch[1];
      return {
        ...file,
        content: file.content + `\nexport default ${constName};\n`,
      };
    }

    const baseName = file.path
      .replace('src/pages/', '')
      .replace(/\.tsx$/, '')
      .replace(/[^a-zA-Z0-9]/g, '');
    const componentName = (baseName.charAt(0).toUpperCase() + baseName.slice(1)) || 'Page';

    return {
      ...file,
      content: file.content + `\nexport default function ${componentName}() {\n  return <div>${componentName}</div>;\n}\n`,
    };
  });
}

export function batchFixKnownPatterns(
  errors: string[],
  repoFiles: { path: string; content: string }[]
): GeneratedFile[] {
  const fixedMap = new Map<string, GeneratedFile>();

  const hasLucideErrors = errors.some((e) =>
    /is not exported by.*lucide-react|has no exported member.*from ['"]lucide-react/.test(e)
  );
  if (hasLucideErrors) {
    for (const file of repoFiles) {
      if (!/\.(tsx?|jsx?)$/.test(file.path)) continue;
      if (!file.content.includes('lucide-react')) continue;
      const sanitized = sanitizeLucideImports([{ path: file.path, content: file.content }]);
      if (sanitized[0].content !== file.content) {
        fixedMap.set(file.path, sanitized[0]);
      }
    }
  }

  const hasDefaultExportErrors = errors.some((e) =>
    /does not provide an export named 'default'|has no default export/.test(e)
  );
  if (hasDefaultExportErrors) {
    const pageFiles = repoFiles.filter(
      (f) => f.path.startsWith('src/pages/') && f.path.endsWith('.tsx')
    );
    const ensured = ensurePageDefaultExports(
      pageFiles.map((f) => fixedMap.get(f.path) || { path: f.path, content: f.content })
    );
    for (let i = 0; i < ensured.length; i++) {
      const original = fixedMap.get(pageFiles[i].path) || pageFiles[i];
      if (ensured[i].content !== original.content) {
        fixedMap.set(ensured[i].path, ensured[i]);
      }
    }
  }

  const hasAliasErrors = errors.some((e) =>
    /@\//.test(e) || /Failed to resolve.*@\//.test(e)
  );
  if (hasAliasErrors) {
    for (const file of repoFiles) {
      if (!/\.(tsx?|jsx?)$/.test(file.path)) continue;
      if (!file.content.includes('@/')) continue;
      const current = fixedMap.get(file.path) || { path: file.path, content: file.content };
      const rewritten = rewriteAliasImports([current]);
      if (rewritten[0].content !== current.content) {
        fixedMap.set(file.path, rewritten[0]);
      }
    }
  }

  return Array.from(fixedMap.values());
}
