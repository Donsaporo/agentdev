const AVG_CHARS_PER_TOKEN = 3.5;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / AVG_CHARS_PER_TOKEN);
}

export function estimateFileTokens(file: { path: string; content: string }): number {
  const header = `--- ${file.path} ---\n`;
  return estimateTokens(header + file.content);
}

export function estimateTokensFromSize(bytes: number): number {
  return Math.ceil(bytes / AVG_CHARS_PER_TOKEN);
}

export function selectFilesWithinBudget(
  files: { path: string; content: string }[],
  maxTokens: number,
  priorityPatterns?: string[]
): { path: string; content: string }[] {
  const priority: typeof files = [];
  const rest: typeof files = [];

  for (const file of files) {
    const lower = file.path.toLowerCase();
    if (priorityPatterns?.some((p) => lower.includes(p))) {
      priority.push(file);
    } else {
      rest.push(file);
    }
  }

  const selected: typeof files = [];
  let usedTokens = 0;

  for (const file of [...priority, ...rest]) {
    const tokens = estimateFileTokens(file);
    if (usedTokens + tokens > maxTokens) {
      if (selected.length === 0) {
        selected.push(file);
        usedTokens += tokens;
      }
      continue;
    }
    selected.push(file);
    usedTokens += tokens;
  }

  return selected;
}

export function selectPathsWithinBudget(
  files: { path: string; size: number }[],
  maxTokens: number,
  priorityPatterns?: string[]
): string[] {
  const priority = files.filter((f) =>
    priorityPatterns?.some((p) => f.path.toLowerCase().includes(p))
  );
  const rest = files.filter((f) => !priority.includes(f));

  const selected: string[] = [];
  let usedTokens = 0;

  for (const file of [...priority, ...rest]) {
    const tokens = estimateTokensFromSize(file.size);
    if (usedTokens + tokens > maxTokens && selected.length > 0) continue;
    selected.push(file.path);
    usedTokens += tokens;
  }

  return selected;
}

export const CONTEXT_BUDGETS = {
  moduleGeneration: 80_000,
  buildFix: 80_000,
  completenessCheck: 100_000,
  completenessFixCoreFiles: 60_000,
  qaFix: 80_000,
} as const;
