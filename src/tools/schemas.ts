import type { ApidogClient } from '../client.js';
import { HTTP_METHODS } from '../types.js';
import type { OpenApiSpec, SchemaInfo } from '../types.js';

function findSchemaReferences(spec: OpenApiSpec): Record<string, string[]> {
  const refs: Record<string, string[]> = {};
  for (const schemaName of Object.keys(spec.components?.schemas ?? {})) {
    refs[schemaName] = [];
  }

  for (const [path, methods] of Object.entries(spec.paths || {})) {
    for (const method of HTTP_METHODS) {
      const op = methods[method];
      if (!op) continue;

      const opStr = JSON.stringify(op);
      const label = `${method.toUpperCase()} ${path}`;

      for (const schemaName of Object.keys(refs)) {
        if (opStr.includes(`"#/components/schemas/${schemaName}"`)) {
          refs[schemaName].push(label);
        }
      }
    }
  }
  return refs;
}

function schemaType(schema: unknown): string {
  if (!schema || typeof schema !== 'object') return 'unknown';
  const s = schema as Record<string, unknown>;
  if (s.type === 'object') return 'object';
  if (s.type === 'array') return 'array';
  if (s.type) return String(s.type);
  if (s.allOf) return 'allOf';
  if (s.oneOf) return 'oneOf';
  if (s.anyOf) return 'anyOf';
  if (s.enum) return 'enum';
  return 'unknown';
}

function propertyCount(schema: unknown): number {
  if (!schema || typeof schema !== 'object') return 0;
  const s = schema as Record<string, unknown>;
  if (s.properties && typeof s.properties === 'object') return Object.keys(s.properties).length;
  return 0;
}

// --- apidog_list_schemas ---

export async function handleListSchemas(
  client: ApidogClient,
  moduleId: number,
): Promise<string> {
  const spec = await client.exportSpec(moduleId, { includeExtensions: true });
  const schemas = spec.components?.schemas ?? {};
  const refs = findSchemaReferences(spec);

  const list: SchemaInfo[] = Object.entries(schemas).map(([name, def]) => ({
    name,
    type: schemaType(def),
    propertyCount: propertyCount(def),
    referencedBy: refs[name] ?? [],
  }));

  list.sort((a, b) => a.name.localeCompare(b.name));

  return JSON.stringify({
    total: list.length,
    schemas: list,
  }, null, 2);
}

// --- apidog_get_schema ---

export async function handleGetSchema(
  client: ApidogClient,
  moduleId: number,
  args: { name: string },
): Promise<string> {
  const spec = await client.exportSpec(moduleId, { includeExtensions: true });
  const schemas = spec.components?.schemas ?? {};
  const definition = schemas[args.name];

  if (!definition) {
    const available = Object.keys(schemas).sort();
    return JSON.stringify({
      error: `Schema "${args.name}" not found`,
      available: available.length > 50 ? { count: available.length, first50: available.slice(0, 50) } : available,
    });
  }

  const refs = findSchemaReferences(spec);

  return JSON.stringify({
    name: args.name,
    type: schemaType(definition),
    propertyCount: propertyCount(definition),
    referencedBy: refs[args.name] ?? [],
    definition,
  }, null, 2);
}

// --- apidog_update_schema ---

export async function handleUpdateSchema(
  client: ApidogClient,
  moduleId: number,
  args: { name: string; definition: unknown },
): Promise<string> {
  const minimalSpec: OpenApiSpec = {
    openapi: '3.1.0',
    info: { title: 'Schema Update', version: '0.0.0' },
    paths: {},
    components: {
      schemas: { [args.name]: args.definition },
    },
  };

  const result = await client.importOpenApi(moduleId, minimalSpec, {
    schemaOverwriteBehavior: 'OVERWRITE_EXISTING',
    endpointOverwriteBehavior: 'KEEP_EXISTING',
  });

  const action = result.data.counters.schemaCreated > 0 ? 'CREATED' : 'UPDATED';

  return JSON.stringify({
    success: true,
    action,
    schema: args.name,
    counters: result.data.counters,
  }, null, 2);
}

// --- apidog_delete_schema ---

export async function handleDeleteSchema(
  client: ApidogClient,
  moduleId: number,
  args: { name: string },
): Promise<string> {
  const spec = await client.exportSpec(moduleId, { includeExtensions: true });

  if (!spec.components?.schemas?.[args.name]) {
    return JSON.stringify({ error: `Schema "${args.name}" not found` });
  }

  const refs = findSchemaReferences(spec);
  if (refs[args.name]?.length > 0) {
    return JSON.stringify({
      error: `Schema "${args.name}" is referenced by ${refs[args.name].length} endpoint(s)`,
      referencedBy: refs[args.name],
      hint: 'Remove references first, then delete the schema',
    });
  }

  delete spec.components!.schemas![args.name];

  const result = await client.importOpenApi(moduleId, spec, {
    endpointOverwriteBehavior: 'OVERWRITE_EXISTING',
    schemaOverwriteBehavior: 'OVERWRITE_EXISTING',
    updateFolderOfChangedEndpoint: true,
    deleteUnmatchedResources: true,
  });

  return JSON.stringify({
    success: true,
    action: 'DELETED',
    schema: args.name,
    counters: result.data.counters,
  }, null, 2);
}
