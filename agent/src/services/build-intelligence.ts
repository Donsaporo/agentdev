import type { GeneratedFile, ArchitecturePage } from '../core/types.js';

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

    const defaultMatch = file.content.match(
      /export\s+default\s+(?:function|class|const)\s+(\w+)/
    );
    if (defaultMatch) {
      defaultExport = defaultMatch[1];
    } else if (file.content.includes('export default')) {
      defaultExport = 'default';
    }

    const namedMatches = file.content.matchAll(
      /export\s+(?:function|const|class|interface|type|enum)\s+(\w+)/g
    );
    for (const match of namedMatches) {
      if (match[1] !== defaultExport) {
        namedExports.push(match[1]);
      }
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
  const rootCauses = new Map<string, string>();

  for (const error of errors) {
    const missingModule = error.match(/(?:Cannot find module|Failed to resolve|Could not resolve)\s+'([^']+)'/);
    if (missingModule) {
      const key = `missing:${missingModule[1]}`;
      if (!rootCauses.has(key)) rootCauses.set(key, error);
      continue;
    }

    const noExport = error.match(/has no exported member '([^']+)'/);
    if (noExport) {
      const key = `no-export:${noExport[1]}`;
      if (!rootCauses.has(key)) rootCauses.set(key, error);
      continue;
    }

    const noProp = error.match(/Property '([^']+)' does not exist on type '([^']+)'/);
    if (noProp) {
      const key = `no-prop:${noProp[1]}:${noProp[2]}`;
      if (!rootCauses.has(key)) rootCauses.set(key, error);
      continue;
    }

    const notAssignable = error.match(/is not assignable to type '([^']+)'/);
    if (notAssignable) {
      const key = `not-assignable:${notAssignable[1]}`;
      if (!rootCauses.has(key)) rootCauses.set(key, error);
      continue;
    }

    const noDefault = error.match(/has no default export/);
    if (noDefault) {
      const fileInError = error.match(/(src\/[^\s:]+)/);
      const key = `no-default:${fileInError?.[1] || error.slice(0, 80)}`;
      if (!rootCauses.has(key)) rootCauses.set(key, error);
      continue;
    }

    const normalized = error
      .replace(/src\/[^\s:]+/g, 'FILE')
      .replace(/\(\d+,\d+\)/g, '(N,N)')
      .replace(/line \d+/gi, 'line N');
    if (!rootCauses.has(normalized)) rootCauses.set(normalized, error);
  }

  return Array.from(rootCauses.values());
}

export function filterRelevantFiles(
  allFiles: { path: string; content: string }[],
  errors: string[]
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
    return allFiles.slice(0, 30);
  }

  return filtered.slice(0, 40);
}

export function reconcileAppRoutes(
  allFilePaths: string[],
  pages: ArchitecturePage[]
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
      .replace(/\//g, '');
    fileMap.set(name.toLowerCase(), fp);
  }

  const imports: string[] = [];
  const routes: string[] = [];
  const usedComponents = new Set<string>();

  for (const page of pages) {
    const normalizedPageName = page.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

    let matchedFile: string | null = null;

    if (fileMap.has(normalizedPageName)) {
      matchedFile = fileMap.get(normalizedPageName)!;
    } else {
      for (const [key, fp] of fileMap) {
        if (key.includes(normalizedPageName) || normalizedPageName.includes(key)) {
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
    imports.push(`import ${componentName} from '${importPath}';`);
    routes.push(`      <Route path="${page.route}" element={<${componentName} />} />`);
  }

  if (imports.length === 0) return null;

  const content = `import { Routes, Route } from 'react-router-dom';
${imports.join('\n')}

export default function App() {
  return (
    <Routes>
${routes.join('\n')}
    </Routes>
  );
}`;

  return { path: 'src/App.tsx', content };
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
      .replace(/\//g, '');
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

export function generateStubForMissingImport(
  error: string,
  allFilePaths: string[]
): GeneratedFile | null {
  const moduleMatch = error.match(
    /(?:Cannot find module|Failed to resolve|Could not resolve)\s+'([^']+)'/
  );
  if (!moduleMatch) return null;

  let modulePath = moduleMatch[1];
  if (!modulePath.startsWith('.')) return null;

  modulePath = modulePath.replace(/^\.\//, 'src/');
  if (!modulePath.includes('.')) {
    modulePath += '.tsx';
  }

  if (allFilePaths.includes(modulePath)) return null;

  const componentName = modulePath
    .replace(/^src\//, '')
    .replace(/\.(tsx?|jsx?)$/, '')
    .replace(/\//g, '')
    .replace(/[^a-zA-Z0-9]/g, '') || 'Placeholder';

  const content = `export default function ${componentName}() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-2xl font-bold mb-4">${componentName}</h1>
        <p className="text-gray-500">This page is under construction.</p>
      </div>
    </div>
  );
}`;

  return { path: modulePath, content };
}
