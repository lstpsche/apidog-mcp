import type { ApidogClient } from '../client.js';
import { HTTP_METHODS } from '../types.js';
import type { OpenApiSpec, ParsedEndpoint } from '../types.js';

function parseEndpoints(spec: OpenApiSpec): ParsedEndpoint[] {
  const endpoints: ParsedEndpoint[] = [];
  for (const [path, methods] of Object.entries(spec.paths || {})) {
    for (const method of HTTP_METHODS) {
      const op = methods[method];
      if (!op) continue;
      endpoints.push({
        method: method.toUpperCase(),
        path,
        summary: op.summary ?? '',
        description: op.description ?? '',
        operationId: op.operationId ?? '',
        tags: op.tags ?? [],
        folder: op['x-apidog-folder'] ?? null,
        status: op['x-apidog-status'] ?? null,
        deprecated: op.deprecated ?? false,
      });
    }
  }
  return endpoints;
}

// --- apidog_export ---

export async function handleExport(
  client: ApidogClient,
  moduleId: number,
  args: { oasVersion?: string; includeExtensions?: boolean },
): Promise<string> {
  const spec = await client.exportSpec(moduleId, {
    oasVersion: (args.oasVersion as '3.0' | '3.1') ?? '3.1',
    includeExtensions: args.includeExtensions,
  });

  const pathCount = Object.keys(spec.paths || {}).length;
  const endpointCount = parseEndpoints(spec).length;

  return JSON.stringify({
    summary: `Exported ${endpointCount} endpoints across ${pathCount} paths`,
    spec,
  });
}

// --- apidog_list (with optional keyword search) ---

export async function handleList(
  client: ApidogClient,
  moduleId: number,
  args: {
    query?: string;
    filterTag?: string;
    filterPath?: string;
    filterFolder?: string;
    filterStatus?: string;
    filterMethod?: string;
    offset?: number;
    limit?: number;
  },
): Promise<string> {
  const spec = await client.exportSpec(moduleId, { includeExtensions: true });
  let endpoints = parseEndpoints(spec);

  if (args.query) {
    const query = args.query.toLowerCase();
    const queryWords = query.split(/[\s\-_\/]+/).filter(Boolean);
    endpoints = endpoints
      .map(ep => {
        let score = 0;
        const fields = [ep.path, ep.summary, ep.description, ...ep.tags, ep.folder ?? ''].map(f => f.toLowerCase());
        for (const field of fields) {
          if (field.includes(query)) score += 10;
          for (const word of queryWords) {
            if (field.includes(word)) score += 3;
          }
        }
        return { ...ep, _score: score };
      })
      .filter(ep => ep._score > 0)
      .sort((a, b) => b._score - a._score)
      .map(({ _score, ...rest }) => rest);
  }

  if (args.filterTag) endpoints = endpoints.filter(e => e.tags.includes(args.filterTag!));
  if (args.filterPath) endpoints = endpoints.filter(e => e.path.includes(args.filterPath!));
  if (args.filterFolder) endpoints = endpoints.filter(e => (e.folder ?? '').includes(args.filterFolder!));
  if (args.filterStatus) endpoints = endpoints.filter(e => e.status === args.filterStatus);
  if (args.filterMethod) endpoints = endpoints.filter(e => e.method.toLowerCase() === args.filterMethod!.toLowerCase());

  const total = endpoints.length;
  const offset = args.offset ?? 0;
  const limit = args.limit ?? 50;
  const page = endpoints.slice(offset, offset + limit);

  return JSON.stringify({
    total,
    offset,
    limit,
    returned: page.length,
    ...(args.query && { query: args.query }),
    endpoints: page.map(e => ({
      method: e.method,
      path: e.path,
      summary: e.summary,
      tags: e.tags,
      folder: e.folder,
      status: e.status,
      deprecated: e.deprecated,
    })),
  }, null, 2);
}

// --- apidog_get ---

export async function handleGet(
  client: ApidogClient,
  moduleId: number,
  args: { method: string; path: string },
): Promise<string> {
  const spec = await client.exportSpec(moduleId, { includeExtensions: true });
  const pathObj = spec.paths?.[args.path];

  if (!pathObj) {
    const available = Object.keys(spec.paths || {}).sort();
    return JSON.stringify({
      error: `Path "${args.path}" not found`,
      availablePaths: available.length > 50
        ? { count: available.length, first50: available.slice(0, 50) }
        : available,
    });
  }

  const method = args.method.toLowerCase();
  const operation = pathObj[method];
  if (!operation) {
    return JSON.stringify({
      error: `Method "${args.method}" not found on "${args.path}"`,
      availableMethods: Object.keys(pathObj).filter(k => HTTP_METHODS.includes(k as typeof HTTP_METHODS[number])),
    });
  }

  const referencedSchemas: Record<string, unknown> = {};
  const opStr = JSON.stringify(operation);
  const refs = [...opStr.matchAll(/"#\/components\/schemas\/([^"]+)"/g)].map(m => m[1]);
  for (const ref of refs) {
    if (spec.components?.schemas?.[ref]) {
      referencedSchemas[ref] = spec.components.schemas[ref];
    }
  }

  return JSON.stringify({
    path: args.path,
    method: method.toUpperCase(),
    operation,
    ...(Object.keys(referencedSchemas).length > 0 && { referencedSchemas }),
  }, null, 2);
}

// --- apidog_folders ---

export async function handleFolders(
  client: ApidogClient,
  moduleId: number,
): Promise<string> {
  const spec = await client.exportSpec(moduleId, { includeExtensions: true });
  const endpoints = parseEndpoints(spec);

  const folders: Record<string, string[]> = {};
  const unfoldered: string[] = [];

  for (const ep of endpoints) {
    const label = `${ep.method} ${ep.path}`;
    if (ep.folder) {
      if (!folders[ep.folder]) folders[ep.folder] = [];
      folders[ep.folder].push(label);
    } else {
      unfoldered.push(label);
    }
  }

  const folderSizes = Object.fromEntries(
    Object.entries(folders)
      .map(([name, eps]) => [name, eps.length] as const)
      .sort((a, b) => b[1] - a[1]),
  );

  return JSON.stringify({
    totalEndpoints: endpoints.length,
    totalFolders: Object.keys(folders).length,
    unfolderedCount: unfoldered.length,
    unfoldered,
    folderTree: folders,
    folderSizes,
  }, null, 2);
}
