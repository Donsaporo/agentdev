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

function matchPagesToFiles(
  pages: ArchitecturePage[],
  fileMap: Map<string, string>
): { componentName: string; importPath: string; route: string }[] {
  const results: { componentName: string; importPath: string; route: string }[] = [];
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

    const componentName = page.name.replace(/[^a-zA-Z0-9]/g, '');
    if (usedComponents.has(componentName)) continue;
    usedComponents.add(componentName);

    const importPath = './' + matchedFile.replace('src/', '').replace(/\.tsx$/, '');
    results.push({ componentName, importPath, route: page.route });
  }

  return results;
}

function buildFreshApp(
  matched: { componentName: string; importPath: string; route: string }[]
): GeneratedFile {
  const imports = matched.map(
    (r) => `import ${r.componentName} from '${r.importPath}';`
  ).join('\n');
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
  existingAppContent?: string
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

  const matched = matchPagesToFiles(pages, fileMap);
  if (matched.length === 0) return null;

  if (!existingAppContent || !existingAppContent.includes('<Routes')) {
    return buildFreshApp(matched);
  }

  const lines = existingAppContent.split('\n');
  const outputLines: string[] = [];
  const pageImportRegex = /^import\s+(\w+)\s+from\s+['"]\.\/pages\//;
  const routesCloseRegex = /^(\s*)<\/Routes>/;
  const correctedImportMap = new Map<string, string>();
  const importedComponents = new Set<string>();

  for (const r of matched) {
    correctedImportMap.set(
      r.componentName.toLowerCase(),
      `import ${r.componentName} from '${r.importPath}';`
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
    const newImportLines = missingImports.map(
      (r) => `import ${r.componentName} from '${r.importPath}';`
    );
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
    const hookName = 'use' + baseName.replace(/^use/i, '').charAt(0).toUpperCase() + baseName.replace(/^use/i, '').slice(1);
    return `export function ${hookName}() {
  return { data: null, loading: false, error: null };
}
export default ${hookName};`;
  }

  if (lower.includes('/contexts/')) {
    const ctxName = baseName.charAt(0).toUpperCase() + baseName.slice(1);
    return `import { createContext, useContext, type ReactNode } from 'react';
const ${ctxName}Ctx = createContext<Record<string, unknown>>({});
export function ${ctxName}Provider({ children }: { children: ReactNode }) {
  return <${ctxName}Ctx.Provider value={{}}>{children}</${ctxName}Ctx.Provider>;
}
export function use${ctxName}() { return useContext(${ctxName}Ctx); }
export { ${ctxName}Ctx as ${ctxName} };`;
  }

  const componentName = baseName.charAt(0).toUpperCase() + baseName.slice(1);
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
