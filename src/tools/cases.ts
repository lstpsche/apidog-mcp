import { ApidogClient, toOpenApiPath } from '../client.js';
import type { ApidogImportCounters, CaseDefinition, OpenApiSpec } from '../types.js';

// --- apidog_create_cases (accepts single case or batch) ---

export async function handleCreateCases(
  client: ApidogClient,
  moduleId: number,
  args: {
    cases: Array<{
      method: string;
      path: string;
      name: string;
      request?: {
        headers?: Record<string, string>;
        queryParams?: Record<string, string>;
        pathParams?: Record<string, string>;
        body?: unknown;
      };
      response?: {
        status: number;
        headers?: Record<string, string>;
        body?: unknown;
      };
    }>;
    overwriteExisting?: boolean;
  },
): Promise<string> {
  if (!args.cases?.length) {
    return JSON.stringify({ error: 'cases array is required and must not be empty' });
  }

  const caseDefs: CaseDefinition[] = args.cases.map(c => ({
    method: c.method,
    path: c.path,
    name: c.name,
    request: c.request,
    response: c.response,
  }));

  const result = await importCasesSafely(client, moduleId, caseDefs, args.overwriteExisting);

  const endpoints = [...new Set(args.cases.map(c => `${c.method.toUpperCase()} ${c.path}`))];

  return JSON.stringify({
    success: true,
    action: 'CREATE_CASES',
    totalCases: args.cases.length,
    endpoints,
    overwriteExisting: args.overwriteExisting ?? false,
    counters: result.counters,
  }, null, 2);
}

// --- Safe case import: preserves endpoint metadata ---
// 1. Export current spec (saves metadata)
// 2. Import Postman with AUTO_MERGE (creates cases, may damage metadata)
// 3. Re-import saved spec for affected paths only (restores metadata)

async function importCasesSafely(
  client: ApidogClient,
  moduleId: number,
  cases: CaseDefinition[],
  overwriteExisting?: boolean,
): Promise<{ counters: ApidogImportCounters }> {
  const affectedPaths = [...new Set(cases.map(c => toOpenApiPath(c.path)))];

  const savedSpec = await client.exportSpec(moduleId);

  const collection = ApidogClient.buildPostmanCollection(cases);
  const importResult = await client.importPostmanCollection(moduleId, collection, {
    endpointOverwriteBehavior: 'AUTO_MERGE',
    endpointCaseOverwriteBehavior: overwriteExisting ? 'OVERWRITE_EXISTING' : 'KEEP_EXISTING',
  });

  const restorationSpec = buildRestorationSpec(savedSpec, affectedPaths);
  if (restorationSpec && Object.keys(restorationSpec.paths).length > 0) {
    await client.importOpenApi(moduleId, restorationSpec, {
      endpointOverwriteBehavior: 'OVERWRITE_EXISTING',
      updateFolderOfChangedEndpoint: true,
    });
  }

  return { counters: importResult.data.counters };
}

function buildRestorationSpec(
  savedSpec: OpenApiSpec,
  affectedPaths: string[],
): OpenApiSpec | null {
  const paths: OpenApiSpec['paths'] = {};

  for (const path of affectedPaths) {
    if (savedSpec.paths[path]) {
      paths[path] = savedSpec.paths[path];
    }
  }

  if (Object.keys(paths).length === 0) return null;

  return {
    openapi: savedSpec.openapi || '3.1.0',
    info: savedSpec.info || { title: 'Restoration', version: '1.0.0' },
    paths,
    components: savedSpec.components,
    tags: savedSpec.tags,
  };
}
