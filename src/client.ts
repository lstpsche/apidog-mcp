import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ApidogImportCounters, ApidogImportResult, OpenApiSpec,
  CaseDefinition, PostmanCollection, PostmanItem, PostmanResponse,
  CliResult, CliTestStep,
} from './types.js';
import { HTTP_METHODS, emptyCounters, mergeCounters } from './types.js';

const BASE_URL = 'https://api.apidog.com';
const API_VERSION = '2024-03-28';

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503]);
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

export interface ImportOpenApiOptions {
  endpointOverwriteBehavior?: 'OVERWRITE_EXISTING' | 'AUTO_MERGE' | 'KEEP_EXISTING' | 'CREATE_NEW';
  schemaOverwriteBehavior?: 'OVERWRITE_EXISTING' | 'AUTO_MERGE' | 'KEEP_EXISTING' | 'CREATE_NEW';
  updateFolderOfChangedEndpoint?: boolean;
  deleteUnmatchedResources?: boolean;
  prependBasePath?: boolean;
}

export interface ImportPostmanOptions {
  endpointOverwriteBehavior?: 'OVERWRITE_EXISTING' | 'KEEP_EXISTING' | 'AUTO_MERGE' | 'CREATE_NEW';
  endpointCaseOverwriteBehavior?: 'OVERWRITE_EXISTING' | 'KEEP_EXISTING' | 'CREATE_NEW';
}

export class ApidogClient {
  private accessToken: string;
  private projectId: string;

  constructor(accessToken: string, projectId: string) {
    this.accessToken = accessToken;
    this.projectId = projectId;
  }

  private get headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.accessToken}`,
      'X-Apidog-Api-Version': API_VERSION,
    };
  }

  // --- Low-level HTTP with retry ---

  private async apiCall<T>(path: string, body: unknown): Promise<T> {
    const url = `${BASE_URL}/v1/projects/${this.projectId}${path}`;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const res = await fetch(url, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
      });

      if (res.ok) return res.json() as Promise<T>;

      const errText = await res.text();

      if (RETRYABLE_STATUS_CODES.has(res.status) && attempt < MAX_RETRIES) {
        const jitter = Math.random() * 0.5 + 0.75;
        const delay = RETRY_BASE_DELAY_MS * Math.pow(3, attempt) * jitter;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      throw new Error(`Apidog API ${res.status} on ${path}: ${errText.slice(0, 500)}`);
    }

    throw new Error('Exhausted retries');
  }

  // --- Export ---

  async exportSpec(moduleId: number, opts?: {
    oasVersion?: '3.0' | '3.1';
    includeExtensions?: boolean;
  }): Promise<OpenApiSpec> {
    const body: Record<string, unknown> = {
      scope: { type: 'ALL' },
      options: {
        includeApidogExtensionProperties: opts?.includeExtensions !== false,
        addFoldersToTags: false,
      },
      oasVersion: opts?.oasVersion ?? '3.1',
      exportFormat: 'JSON',
      moduleId,
    };

    return this.apiCall<OpenApiSpec>('/export-openapi?locale=en-US', body);
  }

  // --- Import OpenAPI ---

  async importOpenApi(
    moduleId: number,
    spec: OpenApiSpec | string,
    opts: ImportOpenApiOptions = {},
  ): Promise<ApidogImportResult> {
    const importOptions: Record<string, unknown> = {
      targetEndpointFolderId: 0,
      targetSchemaFolderId: 0,
      endpointOverwriteBehavior: opts.endpointOverwriteBehavior ?? 'OVERWRITE_EXISTING',
      schemaOverwriteBehavior: opts.schemaOverwriteBehavior ?? 'OVERWRITE_EXISTING',
      updateFolderOfChangedEndpoint: opts.updateFolderOfChangedEndpoint ?? false,
      prependBasePath: opts.prependBasePath ?? false,
      moduleId,
    };

    if (opts.deleteUnmatchedResources) {
      importOptions.deleteUnmatchedResources = true;
    }

    return this.apiCall<ApidogImportResult>('/import-openapi?locale=en-US', {
      input: typeof spec === 'string' ? spec : JSON.stringify(spec),
      options: importOptions,
    });
  }

  // --- Batched import ---

  async importOpenApiBatched(
    moduleId: number,
    spec: OpenApiSpec,
    opts: ImportOpenApiOptions = {},
    batchSize = 15,
  ): Promise<{ counters: ApidogImportCounters; batches: number }> {
    const paths = Object.keys(spec.paths || {});
    if (paths.length <= batchSize) {
      const result = await this.importOpenApi(moduleId, spec, opts);
      return { counters: result.data.counters, batches: 1 };
    }

    let aggregated = emptyCounters();
    let batchCount = 0;

    for (let i = 0; i < paths.length; i += batchSize) {
      const chunk = paths.slice(i, i + batchSize);
      const partialSpec: OpenApiSpec = {
        openapi: spec.openapi,
        info: spec.info,
        paths: {},
        components: spec.components,
        tags: spec.tags,
      };
      for (const p of chunk) {
        partialSpec.paths[p] = spec.paths[p];
      }

      try {
        const result = await this.importOpenApi(moduleId, partialSpec, opts);
        aggregated = mergeCounters(aggregated, result.data.counters);
      } catch (err) {
        if (chunk.length === 1) {
          const stripped = this.stripLargeResponses(partialSpec);
          const result = await this.importOpenApi(moduleId, stripped, opts);
          aggregated = mergeCounters(aggregated, result.data.counters);
        } else {
          for (const p of chunk) {
            const singleSpec: OpenApiSpec = {
              openapi: spec.openapi,
              info: spec.info,
              paths: { [p]: spec.paths[p] },
              components: spec.components,
              tags: spec.tags,
            };
            try {
              const result = await this.importOpenApi(moduleId, singleSpec, opts);
              aggregated = mergeCounters(aggregated, result.data.counters);
            } catch {
              const stripped = this.stripLargeResponses(singleSpec);
              try {
                const result = await this.importOpenApi(moduleId, stripped, opts);
                aggregated = mergeCounters(aggregated, result.data.counters);
              } catch (innerErr) {
                const msg = innerErr instanceof Error ? innerErr.message : String(innerErr);
                throw new Error(`Failed to import path ${p} even after stripping: ${msg}`);
              }
            }
          }
        }
      }
      batchCount++;
    }

    return { counters: aggregated, batches: batchCount };
  }

  private stripLargeResponses(spec: OpenApiSpec): OpenApiSpec {
    const stripped = JSON.parse(JSON.stringify(spec)) as OpenApiSpec;
    for (const pathMethods of Object.values(stripped.paths)) {
      for (const method of HTTP_METHODS) {
        const op = pathMethods[method];
        if (!op?.responses) continue;
        for (const resp of Object.values(op.responses as Record<string, Record<string, unknown>>)) {
          delete resp.content;
        }
      }
    }
    return stripped;
  }

  // --- Import Postman (internal, used by case tools) ---

  async importPostmanCollection(
    moduleId: number,
    collection: PostmanCollection | string,
    opts: ImportPostmanOptions = {},
  ): Promise<ApidogImportResult> {
    const importOptions: Record<string, unknown> = {
      endpointOverwriteBehavior: opts.endpointOverwriteBehavior ?? 'KEEP_EXISTING',
      endpointCaseOverwriteBehavior: opts.endpointCaseOverwriteBehavior ?? 'KEEP_EXISTING',
      moduleId,
    };

    return this.apiCall<ApidogImportResult>('/import-postman-collection?locale=en-US', {
      input: typeof collection === 'string' ? collection : JSON.stringify(collection),
      options: importOptions,
    });
  }

  // --- Replace auto-generated empty "Success" cases ---
  // Apidog auto-creates an empty "Success" case for every new endpoint on OpenAPI import.
  // This replaces those with cases containing the spec's response schema/example.
  // Uses: AUTO_MERGE (to touch the endpoint) + OVERWRITE_EXISTING (to replace the "Success" case).
  // Then restores endpoint metadata from the spec since AUTO_MERGE damages it.

  async replaceAutoSuccessCases(
    moduleId: number,
    spec: OpenApiSpec,
  ): Promise<void> {
    const cases: CaseDefinition[] = [];

    for (const [path, methods] of Object.entries(spec.paths || {})) {
      for (const method of HTTP_METHODS) {
        const op = methods[method];
        if (!op?.responses) continue;

        const successCode = op.responses['200'] ? 200 : op.responses['201'] ? 201 : null;
        if (!successCode) continue;

        const resp = op.responses[String(successCode)] as Record<string, unknown> | undefined;
        const body = extractExampleBody(resp);

        cases.push({
          method,
          path,
          name: 'Success',
          response: { status: successCode, body },
        });
      }
    }

    if (cases.length === 0) return;

    const collection = ApidogClient.buildPostmanCollection(cases);
    await this.importPostmanCollection(moduleId, collection, {
      endpointOverwriteBehavior: 'AUTO_MERGE',
      endpointCaseOverwriteBehavior: 'OVERWRITE_EXISTING',
    });

    await this.importOpenApi(moduleId, spec, {
      endpointOverwriteBehavior: 'OVERWRITE_EXISTING',
      updateFolderOfChangedEndpoint: true,
    });
  }

  // --- Spec from file path ---

  async loadSpecFromFile(filePath: string): Promise<OpenApiSpec> {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content) as OpenApiSpec;
  }

  async resolveSpec(spec?: unknown, specPath?: string): Promise<OpenApiSpec> {
    if (specPath) return this.loadSpecFromFile(specPath);
    if (spec) return spec as OpenApiSpec;
    throw new Error('Either spec (JSON object) or specPath (file path) is required');
  }

  // --- Build Postman collection from structured cases ---

  static buildPostmanCollection(cases: CaseDefinition[]): PostmanCollection {
    const items: PostmanItem[] = cases.map(c => {
      const postmanPath = toPostmanPath(c.path);
      const pathSegments = postmanPath.replace(/^\//, '').split('/');

      const header: Array<{ key: string; value: string }> = [
        { key: 'Content-Type', value: 'application/json' },
      ];
      if (c.request?.headers) {
        for (const [k, v] of Object.entries(c.request.headers)) {
          header.push({ key: k, value: v });
        }
      }

      const query = c.request?.queryParams
        ? Object.entries(c.request.queryParams).map(([key, value]) => ({ key, value }))
        : undefined;

      const pathParamNames = [...postmanPath.matchAll(/:([a-zA-Z_][a-zA-Z0-9_]*)/g)].map(m => m[1]);
      const variable = pathParamNames.length > 0
        ? pathParamNames.map(name => ({ key: name, value: c.request?.pathParams?.[name] ?? '' }))
        : undefined;

      const rawUrl = `{{base_url}}${postmanPath}`;

      const request: PostmanItem['request'] = {
        method: c.method.toUpperCase(),
        header,
        url: {
          raw: rawUrl,
          host: ['{{base_url}}'],
          path: pathSegments,
          ...(query && { query }),
          ...(variable && { variable }),
        },
      };

      if (c.request?.body !== undefined) {
        request.body = {
          mode: 'raw',
          raw: typeof c.request.body === 'string' ? c.request.body : JSON.stringify(c.request.body, null, 2),
          options: { raw: { language: 'json' } },
        };
      }

      const responses: PostmanResponse[] = [];
      if (c.response) {
        const respHeaders = c.response.headers
          ? Object.entries(c.response.headers).map(([key, value]) => ({ key, value }))
          : [{ key: 'Content-Type', value: 'application/json' }];

        responses.push({
          name: c.name,
          originalRequest: request,
          status: httpStatusText(c.response.status),
          code: c.response.status,
          header: respHeaders,
          body: c.response.body !== undefined
            ? (typeof c.response.body === 'string' ? c.response.body : JSON.stringify(c.response.body, null, 2))
            : '',
        });
      }

      return { name: c.name, request, response: responses };
    });

    return {
      info: {
        name: 'MCP Case Import',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item: items,
    };
  }

  // --- CLI test execution ---

  async runCli(args: string[], timeoutMs = 120_000): Promise<CliResult> {
    const reportDir = join(tmpdir(), `apidog-mcp-${randomUUID()}`);
    const cliArgs = [
      'apidog-cli', 'run',
      '--access-token', this.accessToken,
      ...args,
      '-r', 'json,cli',
      '--out-dir', reportDir,
      '--lang', 'en',
    ];

    return new Promise((resolve, reject) => {
      const proc = spawn('npx', cliArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
        env: { ...process.env, NODE_NO_WARNINGS: '1' },
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      proc.on('error', (err) => reject(new Error(`Failed to spawn apidog-cli: ${err.message}`)));

      proc.on('close', async (code) => {
        const rawOutput = stdout + (stderr ? `\n--- stderr ---\n${stderr}` : '');
        const result = await parseCliOutput(code ?? 1, rawOutput, reportDir);
        resolve(result);
      });
    });
  }
}

// --- CLI output parsing ---

async function parseCliOutput(exitCode: number, rawOutput: string, reportDir: string): Promise<CliResult> {
  let steps: CliTestStep[] = [];
  let summary = { total: 0, passed: 0, failed: 0, skipped: 0, duration: 0 };

  try {
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(reportDir).catch(() => [] as string[]);
    const jsonFile = files.find(f => f.endsWith('.json'));

    if (jsonFile) {
      const content = await readFile(join(reportDir, jsonFile), 'utf-8');
      const report = JSON.parse(content);

      if (report.run?.stats) {
        const s = report.run.stats;
        summary.total = s.assertions?.total ?? s.requests?.total ?? 0;
        summary.passed = s.assertions?.passed ?? 0;
        summary.failed = s.assertions?.failed ?? 0;
        summary.duration = s.timings?.completed
          ? s.timings.completed - (s.timings?.started ?? 0)
          : 0;
      }

      if (Array.isArray(report.run?.executions)) {
        steps = report.run.executions.map((exec: Record<string, unknown>) => {
          const item = exec.item as Record<string, unknown> | undefined;
          const req = item?.request as Record<string, unknown> | undefined;
          const resp = exec.response as Record<string, unknown> | undefined;
          const assertions = Array.isArray(exec.assertions) ? exec.assertions : [];

          const allPassed = assertions.every((a: Record<string, unknown>) => !a.error);
          const hasError = exec.requestError as string | undefined;

          return {
            name: (item?.name as string) ?? 'Unknown',
            method: (req?.method as string) ?? '?',
            url: ((req?.url as Record<string, unknown>)?.raw as string) ?? '',
            status: hasError ? 'failed' : allPassed ? 'passed' : 'failed',
            statusCode: (resp?.code as number) ?? undefined,
            duration: (resp?.responseTime as number) ?? undefined,
            assertions: assertions.map((a: Record<string, unknown>) => ({
              name: (a.assertion as string) ?? '',
              passed: !a.error,
              message: a.error ? ((a.error as Record<string, unknown>).message as string) : undefined,
            })),
            error: hasError ?? undefined,
          } satisfies CliTestStep;
        });
      }
    }
  } catch {
    // JSON report unavailable; fall back to raw output only
  }

  if (summary.total === 0 && steps.length > 0) {
    summary.total = steps.length;
    summary.passed = steps.filter(s => s.status === 'passed').length;
    summary.failed = steps.filter(s => s.status === 'failed').length;
    summary.skipped = steps.filter(s => s.status === 'skipped').length;
  }

  return {
    exitCode,
    success: exitCode === 0,
    summary,
    steps,
    rawOutput: rawOutput.slice(0, 10_000),
  };
}

// --- Path normalization ---

// Converts to Postman format: /users/:id
function toPostmanPath(path: string): string {
  let result = path
    .replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, ':$1')
    .replace(/\/+$/, '');
  if (!result.startsWith('/')) result = '/' + result;
  return result;
}

// Converts to OpenAPI format: /users/{id}
export function toOpenApiPath(path: string): string {
  let result = path
    .replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '{$1}')
    .replace(/\/+$/, '');
  if (!result.startsWith('/')) result = '/' + result;
  return result;
}

function extractExampleBody(response: Record<string, unknown> | undefined): unknown {
  if (!response) return undefined;
  const content = response.content as Record<string, { example?: unknown; schema?: unknown }> | undefined;
  if (!content) return undefined;

  const json = content['application/json'] ?? Object.values(content)[0];
  if (!json) return undefined;

  if (json.example !== undefined) return json.example;
  return undefined;
}

function httpStatusText(code: number): string {
  const map: Record<number, string> = {
    200: 'OK', 201: 'Created', 204: 'No Content',
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
    404: 'Not Found', 409: 'Conflict', 422: 'Unprocessable Entity',
    500: 'Internal Server Error',
  };
  return map[code] ?? `Status ${code}`;
}
