import type { ApidogClient } from '../client.js';

// --- apidog_run_test (scenario or folder) ---

export async function handleRunTest(
  client: ApidogClient,
  _moduleId: number,
  args: {
    scenarioId?: string;
    folderId?: string;
    environmentId?: string;
    iterationCount?: number;
    timeoutMs?: number;
  },
): Promise<string> {
  if (!args.scenarioId && !args.folderId) {
    return JSON.stringify({ error: 'Either scenarioId or folderId is required' });
  }
  if (args.scenarioId && args.folderId) {
    return JSON.stringify({ error: 'Provide scenarioId or folderId, not both' });
  }

  const cliArgs: string[] = [];
  if (args.scenarioId) {
    cliArgs.push('-t', args.scenarioId);
  } else {
    cliArgs.push('-f', args.folderId!);
  }

  if (args.environmentId) cliArgs.push('-e', args.environmentId);
  if (args.iterationCount) cliArgs.push('-n', String(args.iterationCount));

  const defaultTimeout = args.folderId ? 180_000 : 120_000;
  const result = await client.runCli(cliArgs, args.timeoutMs ?? defaultTimeout);

  return JSON.stringify({
    success: result.success,
    exitCode: result.exitCode,
    mode: args.scenarioId ? 'scenario' : 'folder',
    target: args.scenarioId ?? args.folderId,
    summary: result.summary,
    steps: result.steps.length > 0 ? result.steps : undefined,
    rawOutput: result.steps.length === 0 ? result.rawOutput : undefined,
  }, null, 2);
}
