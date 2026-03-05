import type { ApidogClient } from '../client.js';
import { HTTP_METHODS } from '../types.js';
import type { OpenApiSpec, EndpointDiff, FieldChange } from '../types.js';
const DIFF_FIELDS = ['summary', 'description', 'operationId', 'tags', 'deprecated', 'x-apidog-folder'] as const;

export async function handleDiff(
  client: ApidogClient,
  moduleId: number,
  args: { spec?: unknown; specPath?: string },
): Promise<string> {
  const localSpec = await client.resolveSpec(args.spec, args.specPath);

  const remoteSpec = await client.exportSpec(moduleId, { includeExtensions: true });
  const diffs: EndpointDiff[] = [];

  const remotePaths = new Set<string>();
  for (const [path, methods] of Object.entries(remoteSpec.paths || {})) {
    for (const method of HTTP_METHODS) {
      if (methods[method]) remotePaths.add(`${method}::${path}`);
    }
  }

  const localPaths = new Set<string>();
  for (const [path, methods] of Object.entries(localSpec.paths || {})) {
    for (const method of HTTP_METHODS) {
      if (methods[method]) localPaths.add(`${method}::${path}`);
    }
  }

  for (const key of localPaths) {
    const [method, path] = key.split('::');
    if (!remotePaths.has(key)) {
      diffs.push({ method: method.toUpperCase(), path, type: 'added' });
      continue;
    }

    const remoteOp = remoteSpec.paths[path]?.[method];
    const localOp = localSpec.paths[path]?.[method];
    if (!remoteOp || !localOp) continue;

    const changes: FieldChange[] = [];
    for (const field of DIFF_FIELDS) {
      const before = remoteOp[field];
      const after = localOp[field];
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        changes.push({ field, before, after });
      }
    }

    if (diffParams(remoteOp.parameters, localOp.parameters)) {
      changes.push({
        field: 'parameters',
        before: summarizeParams(remoteOp.parameters),
        after: summarizeParams(localOp.parameters),
      });
    }

    if (diffResponses(remoteOp.responses, localOp.responses)) {
      changes.push({
        field: 'responses',
        before: Object.keys((remoteOp.responses ?? {}) as Record<string, unknown>),
        after: Object.keys((localOp.responses ?? {}) as Record<string, unknown>),
      });
    }

    if (changes.length > 0) {
      diffs.push({ method: method.toUpperCase(), path, type: 'changed', changes });
    }
  }

  for (const key of remotePaths) {
    if (!localPaths.has(key)) {
      const [method, path] = key.split('::');
      diffs.push({ method: method.toUpperCase(), path, type: 'removed' });
    }
  }

  const added = diffs.filter(d => d.type === 'added').length;
  const removed = diffs.filter(d => d.type === 'removed').length;
  const changed = diffs.filter(d => d.type === 'changed').length;
  const unchanged = localPaths.size - added - changed;

  return JSON.stringify({
    summary: { added, removed, changed, unchanged, total: diffs.length },
    diffs,
  }, null, 2);
}

function diffParams(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? []) !== JSON.stringify(b ?? []);
}

function diffResponses(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? {}) !== JSON.stringify(b ?? {});
}

function summarizeParams(params: unknown): string[] {
  if (!Array.isArray(params)) return [];
  return params.map((p: Record<string, unknown>) => `${p.in}:${p.name}`);
}
