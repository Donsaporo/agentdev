import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractExportSignatures,
  buildExportContext,
  deduplicateErrors,
  filterRelevantFiles,
  reconcileAppRoutes,
  resolveStubPaths,
  generateStubForMissingImport,
} from '../services/build-intelligence.js';

import {
  estimateTokens,
  estimateFileTokens,
  estimateTokensFromSize,
  selectFilesWithinBudget,
  selectPathsWithinBudget,
} from '../core/token-counter.js';

describe('Token Counter', () => {
  it('estimates tokens from text', () => {
    const text = 'Hello world';
    const tokens = estimateTokens(text);
    assert.ok(tokens > 0);
    assert.ok(tokens <= text.length);
  });

  it('estimates tokens from empty string', () => {
    assert.equal(estimateTokens(''), 0);
  });

  it('estimates file tokens including header overhead', () => {
    const file = { path: 'src/App.tsx', content: 'export default function App() {}' };
    const tokens = estimateFileTokens(file);
    const contentOnly = estimateTokens(file.content);
    assert.ok(tokens > contentOnly, 'File tokens should include header overhead');
  });

  it('estimates tokens from byte size', () => {
    const bytes = 3500;
    const tokens = estimateTokensFromSize(bytes);
    assert.equal(tokens, 1000);
  });

  it('selects files within budget', () => {
    const files = [
      { path: 'src/App.tsx', content: 'x'.repeat(350) },
      { path: 'src/pages/Home.tsx', content: 'x'.repeat(350) },
      { path: 'src/pages/About.tsx', content: 'x'.repeat(350) },
      { path: 'src/lib/types.ts', content: 'x'.repeat(350) },
    ];

    const selected = selectFilesWithinBudget(files, 250);
    assert.ok(selected.length >= 1, 'Should select at least one file');
    assert.ok(selected.length < files.length, 'Should not select all files with tight budget');
  });

  it('prioritizes files matching patterns', () => {
    const files = [
      { path: 'src/pages/Home.tsx', content: 'x'.repeat(350) },
      { path: 'src/App.tsx', content: 'x'.repeat(350) },
      { path: 'src/pages/About.tsx', content: 'x'.repeat(350) },
    ];

    const selected = selectFilesWithinBudget(files, 250, ['app.tsx']);
    assert.ok(selected.length >= 1);
    assert.equal(selected[0].path, 'src/App.tsx', 'Priority file should come first');
  });

  it('always selects at least one file even if over budget', () => {
    const files = [
      { path: 'src/huge.tsx', content: 'x'.repeat(100000) },
    ];
    const selected = selectFilesWithinBudget(files, 10);
    assert.equal(selected.length, 1);
  });

  it('selects paths within budget using file sizes', () => {
    const files = [
      { path: 'src/App.tsx', size: 350 },
      { path: 'src/lib/types.ts', size: 700 },
      { path: 'src/pages/Home.tsx', size: 350 },
    ];

    const paths = selectPathsWithinBudget(files, 250, ['lib/types']);
    assert.ok(paths.length >= 1);
    assert.equal(paths[0], 'src/lib/types.ts', 'Priority paths should come first');
  });
});

describe('Export Signatures', () => {
  it('extracts default and named exports', () => {
    const files = [
      {
        path: 'src/components/Button.tsx',
        content: `export default function Button() { return <button />; }
export const ButtonVariant = 'primary';
export interface ButtonProps { label: string; }`,
      },
    ];

    const sigs = extractExportSignatures(files);
    assert.equal(sigs.length, 1);
    assert.equal(sigs[0].defaultExport, 'Button');
    assert.ok(sigs[0].namedExports.includes('ButtonVariant'));
    assert.ok(sigs[0].namedExports.includes('ButtonProps'));
  });

  it('handles files with no exports', () => {
    const files = [
      { path: 'src/index.css', content: '@tailwind base;' },
    ];
    const sigs = extractExportSignatures(files);
    assert.equal(sigs.length, 0);
  });

  it('handles anonymous default exports', () => {
    const files = [
      { path: 'src/config.ts', content: 'export default { key: "value" };' },
    ];
    const sigs = extractExportSignatures(files);
    assert.equal(sigs.length, 1);
    assert.equal(sigs[0].defaultExport, 'default');
  });

  it('builds readable export context', () => {
    const sigs = [
      { path: 'src/lib/api.ts', defaultExport: null, namedExports: ['getUsers', 'createUser'] },
      { path: 'src/components/Layout.tsx', defaultExport: 'Layout', namedExports: [] },
    ];

    const context = buildExportContext(sigs);
    assert.ok(context.includes('src/lib/api.ts'));
    assert.ok(context.includes('getUsers'));
    assert.ok(context.includes('Layout'));
  });

  it('returns empty string for empty signatures', () => {
    assert.equal(buildExportContext([]), '');
  });
});

describe('Error Deduplication', () => {
  it('deduplicates missing module errors', () => {
    const errors = [
      "src/App.tsx(3,20): Cannot find module './pages/Dashboard'",
      "src/components/Nav.tsx(1,20): Cannot find module './pages/Dashboard'",
      "src/App.tsx(5,20): Cannot find module './pages/Settings'",
    ];

    const deduped = deduplicateErrors(errors);
    assert.equal(deduped.length, 2, 'Should collapse same-module errors');
  });

  it('deduplicates no-exported-member errors', () => {
    const errors = [
      "src/pages/Home.tsx(2,10): has no exported member 'UserType'",
      "src/pages/About.tsx(3,10): has no exported member 'UserType'",
    ];
    const deduped = deduplicateErrors(errors);
    assert.equal(deduped.length, 1);
  });

  it('keeps distinct errors separate', () => {
    const errors = [
      "Cannot find module './pages/Dashboard'",
      "Property 'name' does not exist on type 'User'",
      "SyntaxError: Unexpected token",
    ];
    const deduped = deduplicateErrors(errors);
    assert.equal(deduped.length, 3);
  });

  it('handles empty input', () => {
    assert.deepEqual(deduplicateErrors([]), []);
  });
});

describe('Filter Relevant Files', () => {
  const mockFiles = [
    { path: 'package.json', content: '{}' },
    { path: 'src/App.tsx', content: 'export default function App() {}' },
    { path: 'src/main.tsx', content: 'import App from "./App"' },
    { path: 'src/pages/Home.tsx', content: 'export default function Home() {}' },
    { path: 'src/pages/About.tsx', content: 'export default function About() {}' },
    { path: 'src/lib/types.ts', content: 'export interface User {}' },
    { path: 'src/components/Footer.tsx', content: 'export default function Footer() {}' },
  ];

  it('includes core files always', () => {
    const errors = ["src/pages/Home.tsx: Cannot find module './lib/api'"];
    const filtered = filterRelevantFiles(mockFiles, errors);
    const paths = filtered.map((f) => f.path);
    assert.ok(paths.includes('package.json'));
    assert.ok(paths.includes('src/App.tsx'));
  });

  it('includes files referenced in errors', () => {
    const errors = ["src/pages/Home.tsx(5,10): Property 'name' does not exist on type 'User'"];
    const filtered = filterRelevantFiles(mockFiles, errors);
    const paths = filtered.map((f) => f.path);
    assert.ok(paths.includes('src/pages/Home.tsx'));
  });

  it('returns fallback set when too few files match', () => {
    const filtered = filterRelevantFiles(mockFiles, ['some random error with no file references']);
    assert.ok(filtered.length >= 5, 'Should return fallback set');
  });
});

describe('Reconcile App Routes - Structure Preserving', () => {
  const allFilePaths = [
    'src/pages/HomePage.tsx',
    'src/pages/LoginPage.tsx',
    'src/pages/DashboardPage.tsx',
    'src/pages/SettingsPage.tsx',
    'src/components/Layout.tsx',
    'src/components/Navbar.tsx',
    'src/contexts/AuthContext.tsx',
    'src/App.tsx',
    'src/main.tsx',
  ];

  const pages = [
    { name: 'HomePage', route: '/', description: 'Home' },
    { name: 'LoginPage', route: '/login', description: 'Login' },
    { name: 'DashboardPage', route: '/dashboard', description: 'Dashboard' },
    { name: 'SettingsPage', route: '/settings', description: 'Settings' },
  ];

  it('generates fresh app when no existing content', () => {
    const result = reconcileAppRoutes(allFilePaths, pages);
    assert.ok(result !== null);
    assert.equal(result!.path, 'src/App.tsx');
    assert.ok(result!.content.includes('import HomePage'));
    assert.ok(result!.content.includes('import LoginPage'));
    assert.ok(result!.content.includes('<Route path="/"'));
  });

  it('preserves Layout wrapper in existing App.tsx', () => {
    const existing = `import { Routes, Route } from 'react-router-dom';
import { useAuth } from './contexts/AuthContext';
import Layout from './components/Layout';
import HomePage from './pages/HomePage';
import LoginPage from './pages/LoginPage';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  if (!user) return null;
  return <>{children}</>;
}

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/login" element={<LoginPage />} />
      </Routes>
    </Layout>
  );
}`;

    const result = reconcileAppRoutes(allFilePaths, pages, existing);
    assert.ok(result !== null);
    assert.ok(result!.content.includes('import Layout from'), 'Should preserve Layout import');
    assert.ok(result!.content.includes('<Layout>'), 'Should preserve Layout wrapper');
    assert.ok(result!.content.includes('ProtectedRoute'), 'Should preserve ProtectedRoute');
    assert.ok(result!.content.includes("import { useAuth }"), 'Should preserve useAuth import');
  });

  it('adds missing page routes to existing structure', () => {
    const existing = `import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import HomePage from './pages/HomePage';

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<HomePage />} />
      </Routes>
    </Layout>
  );
}`;

    const result = reconcileAppRoutes(allFilePaths, pages, existing);
    assert.ok(result !== null);
    assert.ok(result!.content.includes('import DashboardPage'), 'Should add missing DashboardPage import');
    assert.ok(result!.content.includes('import SettingsPage'), 'Should add missing SettingsPage import');
    assert.ok(result!.content.includes('path="/dashboard"'), 'Should add dashboard route');
    assert.ok(result!.content.includes('path="/settings"'), 'Should add settings route');
    assert.ok(result!.content.includes('<Layout>'), 'Should still preserve Layout');
  });

  it('fixes broken import paths', () => {
    const existing = `import { Routes, Route } from 'react-router-dom';
import HomePage from './pages/Home';
import LoginPage from './pages/Login';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/login" element={<LoginPage />} />
    </Routes>
  );
}`;

    const result = reconcileAppRoutes(allFilePaths, pages, existing);
    assert.ok(result !== null);
    assert.ok(
      result!.content.includes("from './pages/HomePage'"),
      'Should fix HomePage import path'
    );
    assert.ok(
      result!.content.includes("from './pages/LoginPage'"),
      'Should fix LoginPage import path'
    );
  });

  it('removes dead imports for non-existent files', () => {
    const existing = `import { Routes, Route } from 'react-router-dom';
import HomePage from './pages/HomePage';
import DeletedPage from './pages/DeletedPage';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
    </Routes>
  );
}`;

    const result = reconcileAppRoutes(allFilePaths, pages, existing);
    assert.ok(result !== null);
    assert.ok(!result!.content.includes('DeletedPage'), 'Should remove dead import');
    assert.ok(result!.content.includes('HomePage'), 'Should keep valid import');
  });

  it('returns null when no page files exist', () => {
    const result = reconcileAppRoutes(['src/App.tsx', 'src/main.tsx'], pages);
    assert.equal(result, null);
  });

  it('falls back to fresh generation when no Routes block exists', () => {
    const existing = `export default function App() {
  return <div>Hello</div>;
}`;

    const result = reconcileAppRoutes(allFilePaths, pages, existing);
    assert.ok(result !== null);
    assert.ok(result!.content.includes('<Routes>'));
  });
});

describe('Resolve Stub Paths', () => {
  it('maps pages to existing file paths', () => {
    const pages = [
      { name: 'HomePage', route: '/', description: 'Home' },
      { name: 'About', route: '/about', description: 'About' },
    ];
    const allPaths = ['src/pages/HomePage.tsx', 'src/pages/About.tsx'];

    const result = resolveStubPaths(pages, allPaths);
    assert.ok(result.includes('src/pages/HomePage.tsx'));
    assert.ok(result.includes('src/pages/About.tsx'));
  });

  it('generates target paths for missing pages', () => {
    const pages = [{ name: 'Contact', route: '/contact', description: 'Contact' }];
    const allPaths: string[] = [];

    const result = resolveStubPaths(pages, allPaths);
    assert.ok(result.includes('Contact'));
  });
});

describe('Generate Stub For Missing Import', () => {
  it('creates stub for missing relative module', () => {
    const error = "Cannot find module './pages/Dashboard'";
    const stub = generateStubForMissingImport(error, []);
    assert.ok(stub !== null);
    assert.ok(stub!.path.includes('pages'));
    assert.ok(stub!.content.includes('export default function'));
  });

  it('returns null for npm package errors', () => {
    const error = "Cannot find module 'react-icons'";
    const stub = generateStubForMissingImport(error, []);
    assert.equal(stub, null);
  });

  it('returns null if file already exists', () => {
    const error = "Cannot find module './pages/Dashboard'";
    const stub = generateStubForMissingImport(error, ['src/pages/Dashboard.tsx']);
    assert.equal(stub, null);
  });

  it('returns null for non-matching errors', () => {
    const error = "Property 'name' does not exist on type 'User'";
    const stub = generateStubForMissingImport(error, []);
    assert.equal(stub, null);
  });
});

console.log('\n=== Pipeline Integration Tests ===\n');
