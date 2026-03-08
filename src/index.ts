#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';

import { loadConfig, resolveProject, resolveModule } from './config.js';
import type { Config, ProjectConfig } from './config.js';
import { ApidogClient } from './client.js';
import { handleExport, handleList, handleGet, handleFolders } from './tools/read.js';
import { handleImportOpenApi, handleWipe, handleUpdate, handleDelete, handlePipeline } from './tools/write.js';
import { handleCreateCases } from './tools/cases.js';
import { handleDiff } from './tools/diff.js';
import { handleRunTest } from './tools/tests.js';
import { handleListSchemas, handleGetSchema, handleUpdateSchema, handleDeleteSchema } from './tools/schemas.js';
import { handleAnalyze } from './tools/analysis.js';
import { handleBulkUpdate } from './tools/bulk.js';
import { handleExportMarkdown, handleExportCurl, handleExportPostman } from './tools/exports.js';

const VERSION = '6.1.0';

const server = new McpServer({ name: 'apidog-mcp', version: VERSION });

let _config: Config | null = null;
const _clients = new Map<string, ApidogClient>();

async function getMcpRoots(): Promise<string[]> {
  try {
    const { roots } = await server.server.listRoots();
    return roots
      .map(r => {
        try { return fileURLToPath(r.uri); } catch { return null; }
      })
      .filter((p): p is string => p !== null);
  } catch {
    return [];
  }
}

async function ensureConfig(): Promise<Config> {
  if (_config) return _config;

  const roots = await getMcpRoots();
  _config = loadConfig(roots);

  for (const p of _config.projects) {
    _clients.set(p.name, new ApidogClient(_config.accessToken, p.projectId));
  }

  const summary = _config.projects
    .map(p => `${p.name}(${p.projectId})[${Object.keys(p.modules).join(',')}]`)
    .join(' ');
  console.error(`apidog-mcp v${VERSION} loaded | ${summary}`);

  return _config;
}

function getClient(project: ProjectConfig): ApidogClient {
  return _clients.get(project.name)!;
}

type ToolResult = { content: Array<{ type: 'text'; text: string }> };

function errorResult(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }] };
}

const projectParam = z.string().optional().describe(
  'Project name. Required when multiple projects are configured, optional otherwise.',
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tool(handler: (client: ApidogClient, moduleId: number, args: any) => Promise<string>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (args: any): Promise<ToolResult> => {
    try {
      const config = await ensureConfig();
      const project = resolveProject(config, args.project);
      const client = getClient(project);
      const moduleId = resolveModule(project, args.module);
      const text = await handler(client, moduleId, args);
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return errorResult(err);
    }
  };
}

// --- apidog_modules (no module param) ---

server.tool(
  'apidog_modules',
  'List all configured Apidog projects and their modules with names and IDs',
  {
    project: projectParam,
  },
  async (args) => {
    try {
      const config = await ensureConfig();
      const projects = args.project
        ? [resolveProject(config, args.project)]
        : config.projects;

      const result = projects.map(p => ({
        name: p.name,
        projectId: p.projectId,
        modules: Object.entries(p.modules).map(([name, id]) => ({ name, id })),
      }));

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result.length === 1 ? result[0] : result, null, 2),
        }],
      };
    } catch (err) {
      return errorResult(err);
    }
  },
);

// --- Read tools ---

server.tool(
  'apidog_export',
  'Export full OpenAPI spec for an Apidog module',
  {
    project: projectParam,
    module: z.string().describe('Module name (e.g. "api", "engine")'),
    oasVersion: z.enum(['3.0', '3.1']).optional().describe('OpenAPI version (default 3.1)'),
    includeExtensions: z.boolean().optional().describe('Include x-apidog-* extensions (default true)'),
  },
  tool(handleExport),
);

server.tool(
  'apidog_list',
  'List and search endpoints in an Apidog module. Supports keyword search (scored by relevance), filters, and pagination.',
  {
    project: projectParam,
    module: z.string().describe('Module name'),
    query: z.string().optional().describe('Search keyword (searches path, summary, description, tags, folder). Results scored by relevance.'),
    filterTag: z.string().optional().describe('Filter by tag name'),
    filterPath: z.string().optional().describe('Filter by path substring'),
    filterFolder: z.string().optional().describe('Filter by folder name substring'),
    filterStatus: z.string().optional().describe('Filter by status (e.g. "released", "deprecated")'),
    filterMethod: z.string().optional().describe('Filter by HTTP method'),
    offset: z.number().optional().describe('Pagination offset (default 0)'),
    limit: z.number().optional().describe('Pagination limit (default 50)'),
  },
  tool(handleList),
);

server.tool(
  'apidog_get',
  'Get full details of a single endpoint including operation object and referenced schemas',
  {
    project: projectParam,
    module: z.string().describe('Module name'),
    method: z.string().describe('HTTP method (case-insensitive, e.g. GET or get)'),
    path: z.string().describe('Endpoint path, e.g. /api/v2/users/{id}'),
  },
  tool(handleGet),
);

server.tool(
  'apidog_folders',
  'Analyze folder structure of an Apidog module — counts, tree, unfoldered endpoints',
  {
    project: projectParam,
    module: z.string().describe('Module name'),
  },
  tool(handleFolders),
);

// --- Write tools ---

server.tool(
  'apidog_import_openapi',
  'Import an OpenAPI spec into an Apidog module. Auto-batches large specs to avoid payload limits. Accepts a file path or inline JSON.',
  {
    project: projectParam,
    module: z.string().describe('Module name'),
    spec: z.unknown().optional().describe('OpenAPI spec as JSON object'),
    specPath: z.string().optional().describe('Path to OpenAPI spec JSON file'),
    overwriteBehavior: z.enum(['OVERWRITE_EXISTING', 'AUTO_MERGE', 'KEEP_EXISTING', 'CREATE_NEW']).optional()
      .describe('How to handle matched endpoints (default OVERWRITE_EXISTING)'),
    updateFolders: z.boolean().optional().describe('Update folder assignments from x-apidog-folder (default false)'),
    deleteUnmatched: z.boolean().optional().describe('Delete endpoints not in the imported spec (default false)'),
    batchSize: z.number().optional().describe('Paths per import batch (default 15)'),
  },
  tool(handleImportOpenApi),
);

server.tool(
  'apidog_wipe',
  'Wipe ALL endpoints in an Apidog module. Requires confirm=true as safety gate. Irreversible.',
  {
    project: projectParam,
    module: z.string().describe('Module name'),
    confirm: z.boolean().describe('Must be true to proceed'),
  },
  tool(handleWipe),
);

server.tool(
  'apidog_update',
  'Update a single endpoint via targeted partial spec import. Does not affect other endpoints.',
  {
    project: projectParam,
    module: z.string().describe('Module name'),
    method: z.string().describe('HTTP method (case-insensitive)'),
    path: z.string().describe('Endpoint path'),
    operation: z.record(z.unknown()).describe('Full OpenAPI operation object'),
  },
  tool(handleUpdate),
);

server.tool(
  'apidog_delete',
  'Delete an endpoint from Apidog. Exports current spec, removes the target, reimports with deleteUnmatchedResources.',
  {
    project: projectParam,
    module: z.string().describe('Module name'),
    method: z.string().describe('HTTP method (case-insensitive)'),
    path: z.string().describe('Endpoint path'),
  },
  tool(handleDelete),
);

server.tool(
  'apidog_pipeline',
  'Run the proven 3-step pipeline: (1) wipe module, (2) create cases from structured data, (3) overlay enriched OpenAPI spec in batches. Accepts file paths or inline data.',
  {
    project: projectParam,
    module: z.string().describe('Module name'),
    openapiSpecPath: z.string().optional().describe('Path to enriched OpenAPI spec JSON file'),
    openapiSpec: z.unknown().optional().describe('OpenAPI spec as JSON object'),
    cases: z.array(z.object({
      method: z.string(),
      path: z.string(),
      name: z.string(),
      request: z.object({
        headers: z.record(z.string()).optional(),
        queryParams: z.record(z.string()).optional(),
        pathParams: z.record(z.string()).optional(),
        body: z.unknown().optional(),
      }).optional(),
      response: z.object({
        status: z.number(),
        headers: z.record(z.string()).optional(),
        body: z.unknown().optional(),
      }).optional(),
    })).optional().describe('Structured endpoint cases to create in step 2'),
    batchSize: z.number().optional().describe('Paths per import batch for step 3 (default 15)'),
  },
  tool(handlePipeline),
);

// --- Case tool ---

server.tool(
  'apidog_create_cases',
  'Create one or more endpoint cases (usage examples). Pass a single-item or multi-item array. Internally builds a Postman collection and imports safely. Never overwrites endpoint definitions — only manages cases.',
  {
    project: projectParam,
    module: z.string().describe('Module name'),
    cases: z.array(z.object({
      method: z.string().describe('HTTP method (GET, POST, etc.)'),
      path: z.string().describe('Endpoint path, e.g. /auth/sessions'),
      name: z.string().describe('Case name, e.g. "Login with phone"'),
      request: z.object({
        headers: z.record(z.string()).optional(),
        queryParams: z.record(z.string()).optional(),
        pathParams: z.record(z.string()).optional(),
        body: z.unknown().optional(),
      }).optional(),
      response: z.object({
        status: z.number().describe('HTTP status code'),
        headers: z.record(z.string()).optional(),
        body: z.unknown().optional(),
      }).optional(),
    })).describe('Array of case definitions (single or multiple)'),
    overwriteExisting: z.boolean().optional()
      .describe('If true, overwrites cases with same names (default false — skips existing)'),
  },
  tool(handleCreateCases),
);

// --- Diff tool ---

server.tool(
  'apidog_diff',
  'Compare current Apidog state against a provided OpenAPI spec. Reports added, removed, and changed endpoints with field-level diffs.',
  {
    project: projectParam,
    module: z.string().describe('Module name'),
    spec: z.unknown().optional().describe('OpenAPI spec as JSON object'),
    specPath: z.string().optional().describe('Path to OpenAPI spec JSON file'),
  },
  tool(handleDiff),
);

// --- Test execution tool ---

server.tool(
  'apidog_run_test',
  'Run Apidog tests via CLI. Provide scenarioId for a single scenario OR folderId for all scenarios in a folder.',
  {
    project: projectParam,
    module: z.string().describe('Module name (used for context only — tests are project-scoped)'),
    scenarioId: z.string().optional().describe('Test scenario ID (mutually exclusive with folderId)'),
    folderId: z.string().optional().describe('Test folder ID (mutually exclusive with scenarioId)'),
    environmentId: z.string().optional().describe('Environment ID to use for the test run'),
    iterationCount: z.number().optional().describe('Number of iterations (default 1, scenario only)'),
    timeoutMs: z.number().optional().describe('CLI execution timeout in ms (default 120000 scenario / 180000 folder)'),
  },
  tool(handleRunTest),
);

// --- Schema management tools ---

server.tool(
  'apidog_list_schemas',
  'List all component schemas in an Apidog module with types, property counts, and referencing endpoints.',
  {
    project: projectParam,
    module: z.string().describe('Module name'),
  },
  tool(handleListSchemas),
);

server.tool(
  'apidog_get_schema',
  'Get full JSON Schema definition by name, plus list of endpoints that reference it.',
  {
    project: projectParam,
    module: z.string().describe('Module name'),
    name: z.string().describe('Schema name (e.g. "User", "Product")'),
  },
  tool(handleGetSchema),
);

server.tool(
  'apidog_update_schema',
  'Create or update a component schema via targeted spec import.',
  {
    project: projectParam,
    module: z.string().describe('Module name'),
    name: z.string().describe('Schema name'),
    definition: z.record(z.unknown()).describe('Full JSON Schema definition object'),
  },
  tool(handleUpdateSchema),
);

server.tool(
  'apidog_delete_schema',
  'Delete a component schema. Refuses if the schema is still referenced by endpoints.',
  {
    project: projectParam,
    module: z.string().describe('Module name'),
    name: z.string().describe('Schema name to delete'),
  },
  tool(handleDeleteSchema),
);

// --- Analysis tool ---

server.tool(
  'apidog_analyze',
  'Analyze an Apidog module. Use checks param to select: "coverage" (missing summaries, descriptions, tags, etc.) and/or "validate" (duplicate IDs, orphaned schemas, missing params, etc.). Defaults to both.',
  {
    project: projectParam,
    module: z.string().describe('Module name'),
    checks: z.array(z.enum(['coverage', 'validate'])).optional()
      .describe('Which checks to run (default: both). Options: "coverage", "validate".'),
  },
  tool(handleAnalyze),
);

// --- Bulk operation tool ---

server.tool(
  'apidog_bulk_update',
  'Batch update endpoints. Target by explicit endpoints array OR keyword filters. Supports: addTags, removeTags, setFolder, setStatus, setSummaryPrefix, summaryFindReplace. Set confirm=false to preview.',
  {
    project: projectParam,
    module: z.string().describe('Module name'),
    endpoints: z.array(z.object({
      method: z.string().describe('HTTP method'),
      path: z.string().describe('Endpoint path'),
    })).optional().describe('Explicit list of endpoints to update (alternative to filters)'),
    filterTag: z.string().optional().describe('Filter by tag name'),
    filterFolder: z.string().optional().describe('Filter by folder name'),
    filterPath: z.string().optional().describe('Filter by path substring'),
    filterMethod: z.string().optional().describe('Filter by HTTP method'),
    filterStatus: z.string().optional().describe('Filter by x-apidog-status'),
    addTags: z.array(z.string()).optional().describe('Tags to add'),
    removeTags: z.array(z.string()).optional().describe('Tags to remove'),
    setFolder: z.string().optional().describe('Set x-apidog-folder (empty string to clear)'),
    setStatus: z.string().optional().describe('Set x-apidog-status (designing, pending, developing, testing, released, deprecated, obsolete)'),
    setSummaryPrefix: z.string().optional().describe('Prefix to add to summaries (idempotent)'),
    summaryFindReplace: z.object({
      find: z.string(),
      replace: z.string(),
    }).optional().describe('Find/replace in summaries'),
    confirm: z.boolean().optional().describe('Set true to apply, false/omit to preview'),
  },
  tool(handleBulkUpdate),
);

// --- Export format tools ---

server.tool(
  'apidog_export_markdown',
  'Export module documentation as Markdown. Groups endpoints by folder or tag. Suitable for README or docs sites.',
  {
    project: projectParam,
    module: z.string().describe('Module name'),
    groupBy: z.enum(['folder', 'tag']).optional().describe('Group endpoints by folder or tag (default folder)'),
    includeSchemas: z.boolean().optional().describe('Append component schemas at the end (default false)'),
  },
  tool(handleExportMarkdown),
);

server.tool(
  'apidog_export_curl',
  'Export endpoints as ready-to-use curl command examples with placeholder values.',
  {
    project: projectParam,
    module: z.string().describe('Module name'),
    baseUrl: z.string().describe('Base URL for the API (e.g. https://api.example.com)'),
    filterPath: z.string().optional().describe('Filter by path substring'),
    filterTag: z.string().optional().describe('Filter by tag name'),
    filterMethod: z.string().optional().describe('Filter by HTTP method'),
    includeHeaders: z.record(z.string()).optional().describe('Extra headers to include (e.g. {"Authorization": "Bearer <token>"})'),
  },
  tool(handleExportCurl),
);

server.tool(
  'apidog_export_postman',
  'Convert module to a Postman Collection v2.1 format with folder structure and placeholder values.',
  {
    project: projectParam,
    module: z.string().describe('Module name'),
    baseUrl: z.string().optional().describe('Base URL (default: {{base_url}})'),
  },
  tool(handleExportPostman),
);

// --- Start server ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`apidog-mcp v${VERSION} running — config loads on first tool call`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
