import { ApidogClient } from '../client.js';
import { HTTP_METHODS } from '../types.js';
import type { OpenApiSpec, OpenApiOperation, CaseDefinition } from '../types.js';

// --- apidog_import_openapi ---

export async function handleImportOpenApi(
  client: ApidogClient,
  moduleId: number,
  args: {
    spec?: unknown;
    specPath?: string;
    overwriteBehavior?: string;
    updateFolders?: boolean;
    deleteUnmatched?: boolean;
    batchSize?: number;
  },
): Promise<string> {
  const spec = await client.resolveSpec(args.spec, args.specPath);

  const result = await client.importOpenApiBatched(moduleId, spec, {
    endpointOverwriteBehavior: (args.overwriteBehavior as 'OVERWRITE_EXISTING') ?? 'OVERWRITE_EXISTING',
    schemaOverwriteBehavior: (args.overwriteBehavior as 'OVERWRITE_EXISTING') ?? 'OVERWRITE_EXISTING',
    updateFolderOfChangedEndpoint: args.updateFolders ?? false,
    deleteUnmatchedResources: args.deleteUnmatched ?? false,
  }, args.batchSize ?? 15);

  if (result.counters.endpointCreated > 0) {
    await client.replaceAutoSuccessCases(moduleId, spec);
  }

  return JSON.stringify({
    success: true,
    batches: result.batches,
    counters: result.counters,
  }, null, 2);
}

// --- apidog_wipe ---

export async function handleWipe(
  client: ApidogClient,
  moduleId: number,
  args: { confirm?: boolean },
): Promise<string> {
  if (!args.confirm) {
    return JSON.stringify({
      error: 'Safety gate: set confirm=true to wipe all endpoints in this module. This is irreversible.',
    });
  }

  const emptySpec: OpenApiSpec = {
    openapi: '3.1.0',
    info: { title: 'Wipe', version: '0.0.0' },
    paths: {},
  };

  const result = await client.importOpenApi(moduleId, emptySpec, {
    deleteUnmatchedResources: true,
  });

  return JSON.stringify({
    success: true,
    action: 'WIPE_MODULE',
    counters: result.data.counters,
  }, null, 2);
}

// --- apidog_update ---

export async function handleUpdate(
  client: ApidogClient,
  moduleId: number,
  args: { method: string; path: string; operation: OpenApiOperation },
): Promise<string> {
  const partialSpec: OpenApiSpec = {
    openapi: '3.1.0',
    info: { title: 'Partial Update', version: '0.0.0' },
    paths: {
      [args.path]: {
        [args.method.toLowerCase()]: args.operation,
      },
    },
  };

  if (args.operation.tags?.length) {
    partialSpec.tags = args.operation.tags.map(t => ({ name: t }));
  }

  const result = await client.importOpenApi(moduleId, partialSpec, {
    endpointOverwriteBehavior: 'OVERWRITE_EXISTING',
    schemaOverwriteBehavior: 'OVERWRITE_EXISTING',
    updateFolderOfChangedEndpoint: true,
  });

  if (result.data.counters.endpointCreated > 0) {
    await client.replaceAutoSuccessCases(moduleId, partialSpec);
  }

  return JSON.stringify({
    success: true,
    action: result.data.counters.endpointCreated > 0 ? 'CREATED' : 'UPDATED',
    endpoint: `${args.method.toUpperCase()} ${args.path}`,
    counters: result.data.counters,
  }, null, 2);
}

// --- apidog_delete ---

export async function handleDelete(
  client: ApidogClient,
  moduleId: number,
  args: { method: string; path: string },
): Promise<string> {
  const spec = await client.exportSpec(moduleId, { includeExtensions: true });
  const method = args.method.toLowerCase();

  if (!spec.paths?.[args.path]?.[method]) {
    return JSON.stringify({
      error: `Endpoint ${args.method.toUpperCase()} ${args.path} not found`,
    });
  }

  delete spec.paths[args.path][method];

  const remainingMethods = Object.keys(spec.paths[args.path]).filter(
    k => HTTP_METHODS.includes(k as typeof HTTP_METHODS[number]),
  );
  if (remainingMethods.length === 0) {
    delete spec.paths[args.path];
  }

  const result = await client.importOpenApi(moduleId, spec, {
    endpointOverwriteBehavior: 'OVERWRITE_EXISTING',
    schemaOverwriteBehavior: 'OVERWRITE_EXISTING',
    updateFolderOfChangedEndpoint: true,
    deleteUnmatchedResources: true,
  });

  return JSON.stringify({
    success: true,
    action: 'DELETED',
    endpoint: `${args.method.toUpperCase()} ${args.path}`,
    counters: result.data.counters,
  }, null, 2);
}

// --- apidog_pipeline ---

export async function handlePipeline(
  client: ApidogClient,
  moduleId: number,
  args: {
    openapiSpecPath?: string;
    openapiSpec?: unknown;
    cases?: CaseDefinition[];
    batchSize?: number;
  },
): Promise<string> {
  const steps: Array<{ step: string; result: unknown }> = [];

  const emptySpec: OpenApiSpec = {
    openapi: '3.1.0',
    info: { title: 'Pipeline Wipe', version: '0.0.0' },
    paths: {},
  };
  const wipeResult = await client.importOpenApi(moduleId, emptySpec, {
    deleteUnmatchedResources: true,
  });
  steps.push({ step: '1_wipe', result: wipeResult.data.counters });

  if (args.cases?.length) {
    const collection = ApidogClient.buildPostmanCollection(args.cases);
    const caseResult = await client.importPostmanCollection(moduleId, collection, {
      endpointOverwriteBehavior: 'KEEP_EXISTING',
      endpointCaseOverwriteBehavior: 'OVERWRITE_EXISTING',
    });
    steps.push({ step: '2_cases', result: caseResult.data.counters });
  } else {
    steps.push({ step: '2_cases', result: 'skipped (no cases provided)' });
  }

  let spec: OpenApiSpec | null = null;
  try {
    spec = await client.resolveSpec(args.openapiSpec, args.openapiSpecPath);
  } catch {
    // no spec provided — acceptable for pipeline
  }

  if (spec) {
    const overlayResult = await client.importOpenApiBatched(
      moduleId,
      spec,
      {
        endpointOverwriteBehavior: 'OVERWRITE_EXISTING',
        schemaOverwriteBehavior: 'OVERWRITE_EXISTING',
        updateFolderOfChangedEndpoint: true,
      },
      args.batchSize ?? 15,
    );
    steps.push({ step: '3_overlay', result: { batches: overlayResult.batches, counters: overlayResult.counters } });

    if (overlayResult.counters.endpointCreated > 0) {
      await client.replaceAutoSuccessCases(moduleId, spec);
    }
  } else {
    steps.push({ step: '3_overlay', result: 'skipped (no spec provided)' });
  }

  return JSON.stringify({ success: true, pipeline: steps }, null, 2);
}
