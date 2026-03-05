import type { ApidogClient } from '../client.js';
import { HTTP_METHODS, allEndpoints } from '../types.js';
import type { OpenApiSpec, EndpointRef } from '../types.js';

const VALID_STATUSES = ['designing', 'pending', 'developing', 'testing', 'released', 'deprecated', 'obsolete'] as const;

function matchesFilter(
  ep: EndpointRef,
  spec: OpenApiSpec,
  filters: {
    filterTag?: string;
    filterFolder?: string;
    filterPath?: string;
    filterMethod?: string;
    filterStatus?: string;
  },
): boolean {
  const op = spec.paths[ep.path]?.[ep.method];
  if (!op) return false;

  if (filters.filterMethod && ep.method !== filters.filterMethod.toLowerCase()) return false;
  if (filters.filterPath && !ep.path.includes(filters.filterPath)) return false;
  if (filters.filterTag && !(Array.isArray(op.tags) && op.tags.includes(filters.filterTag))) return false;
  if (filters.filterFolder && op['x-apidog-folder'] !== filters.filterFolder) return false;
  if (filters.filterStatus && op['x-apidog-status'] !== filters.filterStatus) return false;

  return true;
}

// --- apidog_bulk_update (supports explicit endpoints list OR keyword filters) ---

export async function handleBulkUpdate(
  client: ApidogClient,
  moduleId: number,
  args: {
    endpoints?: Array<{ method: string; path: string }>;
    filterTag?: string;
    filterFolder?: string;
    filterPath?: string;
    filterMethod?: string;
    filterStatus?: string;
    addTags?: string[];
    removeTags?: string[];
    setFolder?: string;
    setStatus?: string;
    setSummaryPrefix?: string;
    summaryFindReplace?: { find: string; replace: string };
    confirm?: boolean;
  },
): Promise<string> {
  if (args.setStatus && !VALID_STATUSES.includes(args.setStatus as typeof VALID_STATUSES[number])) {
    return JSON.stringify({
      error: `Invalid status "${args.setStatus}". Must be one of: ${VALID_STATUSES.join(', ')}`,
    });
  }

  const hasFilter = args.endpoints?.length || args.filterTag || args.filterFolder
    || args.filterPath || args.filterMethod || args.filterStatus;
  if (!hasFilter) {
    return JSON.stringify({ error: 'Provide endpoints array or at least one filter to prevent accidental bulk updates' });
  }

  const hasUpdate = args.addTags || args.removeTags || args.setFolder !== undefined
    || args.setStatus || args.setSummaryPrefix || args.summaryFindReplace;
  if (!hasUpdate) {
    return JSON.stringify({
      error: 'At least one update operation is required (addTags, removeTags, setFolder, setStatus, setSummaryPrefix, summaryFindReplace)',
    });
  }

  const spec = await client.exportSpec(moduleId, { includeExtensions: true });
  const eps = allEndpoints(spec);

  let matching: EndpointRef[];
  const notFound: string[] = [];

  if (args.endpoints?.length) {
    matching = [];
    for (const ep of args.endpoints) {
      const method = ep.method.toLowerCase();
      const found = eps.find(e => e.method === method && e.path === ep.path);
      if (found) {
        matching.push(found);
      } else {
        notFound.push(`${ep.method.toUpperCase()} ${ep.path}`);
      }
    }
  } else {
    matching = eps.filter(ep => matchesFilter(ep, spec, args));
  }

  if (matching.length === 0) {
    return JSON.stringify({
      error: 'No matching endpoints found',
      ...(notFound.length > 0 && { notFound }),
    });
  }

  if (!args.confirm) {
    const changes: string[] = [];
    if (args.addTags?.length) changes.push(`Add tags: ${args.addTags.join(', ')}`);
    if (args.removeTags?.length) changes.push(`Remove tags: ${args.removeTags.join(', ')}`);
    if (args.setFolder !== undefined) changes.push(`Set folder: "${args.setFolder}"`);
    if (args.setStatus) changes.push(`Set status: ${args.setStatus}`);
    if (args.setSummaryPrefix) changes.push(`Prefix summary with: "${args.setSummaryPrefix}"`);
    if (args.summaryFindReplace) changes.push(`Replace "${args.summaryFindReplace.find}" with "${args.summaryFindReplace.replace}" in summary`);

    return JSON.stringify({
      preview: true,
      matchingEndpoints: matching.map(e => e.label),
      matchCount: matching.length,
      plannedChanges: changes,
      ...(notFound.length > 0 && { notFound }),
      hint: 'Set confirm=true to apply these changes',
    }, null, 2);
  }

  let updatedCount = 0;
  for (const ep of matching) {
    const op = spec.paths[ep.path]?.[ep.method];
    if (!op) continue;

    if (args.addTags?.length) {
      const existing = new Set(op.tags ?? []);
      for (const t of args.addTags) existing.add(t);
      op.tags = [...existing];
    }

    if (args.removeTags?.length) {
      op.tags = (op.tags ?? []).filter(t => !args.removeTags!.includes(t));
    }

    if (args.setFolder !== undefined) {
      op['x-apidog-folder'] = args.setFolder || undefined;
    }

    if (args.setStatus) {
      op['x-apidog-status'] = args.setStatus;
    }

    if (args.setSummaryPrefix && op.summary) {
      if (!op.summary.startsWith(args.setSummaryPrefix)) {
        op.summary = `${args.setSummaryPrefix}${op.summary}`;
      }
    }

    if (args.summaryFindReplace && op.summary) {
      op.summary = op.summary.replaceAll(args.summaryFindReplace.find, args.summaryFindReplace.replace);
    }

    updatedCount++;
  }

  const usedTags = new Set<string>();
  for (const methods of Object.values(spec.paths || {})) {
    for (const method of HTTP_METHODS) {
      const op = methods[method];
      if (Array.isArray(op?.tags)) {
        for (const t of op.tags) usedTags.add(t);
      }
    }
  }
  spec.tags = [...usedTags].sort().map(name => {
    const existing = (spec.tags ?? []).find(t => t.name === name);
    return existing ?? { name };
  });

  const result = await client.importOpenApi(moduleId, spec, {
    endpointOverwriteBehavior: 'OVERWRITE_EXISTING',
    updateFolderOfChangedEndpoint: true,
  });

  return JSON.stringify({
    success: true,
    updatedEndpoints: updatedCount,
    ...(notFound.length > 0 && { notFound }),
    counters: result.data.counters,
  }, null, 2);
}
