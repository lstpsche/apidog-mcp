// --- Apidog API response types ---

export interface ApidogImportCounters {
  endpointCreated: number;
  endpointUpdated: number;
  endpointFailed: number;
  endpointIgnored: number;
  schemaCreated: number;
  schemaUpdated: number;
  schemaFailed: number;
  schemaIgnored: number;
  endpointFolderCreated: number;
  endpointFolderUpdated: number;
  endpointFolderFailed: number;
  endpointFolderIgnored: number;
  schemaFolderCreated: number;
  schemaFolderUpdated: number;
  schemaFolderFailed: number;
  schemaFolderIgnored: number;
}

export interface ApidogImportResult {
  data: {
    counters: ApidogImportCounters;
    errors?: Array<{ message: string; code: string }>;
  };
}

// --- OpenAPI types (minimal, used for spec manipulation) ---

export interface OpenApiSpec {
  openapi: string;
  info: { title: string; version: string; description?: string };
  paths: Record<string, Record<string, OpenApiOperation>>;
  components?: { schemas?: Record<string, unknown> };
  tags?: Array<{ name: string; description?: string }>;
  servers?: Array<{ url: string; description?: string }>;
  security?: unknown[];
  [key: string]: unknown;
}

export interface OpenApiOperation {
  summary?: string;
  description?: string;
  operationId?: string;
  tags?: string[];
  parameters?: unknown[];
  requestBody?: unknown;
  responses?: Record<string, unknown>;
  security?: unknown[];
  deprecated?: boolean;
  'x-apidog-folder'?: string;
  'x-apidog-status'?: string;
  'x-apidog-maintainer'?: string;
  [key: string]: unknown;
}

// --- Parsed endpoint (flattened from spec for listing/filtering) ---

export interface ParsedEndpoint {
  method: string;
  path: string;
  summary: string;
  description: string;
  operationId: string;
  tags: string[];
  folder: string | null;
  status: string | null;
  deprecated: boolean;
}

// --- Case types (agent-facing) ---

export interface CaseRequest {
  headers?: Record<string, string>;
  queryParams?: Record<string, string>;
  pathParams?: Record<string, string>;
  body?: unknown;
}

export interface CaseResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface CaseDefinition {
  method: string;
  path: string;
  name: string;
  request?: CaseRequest;
  response?: CaseResponse;
}

// --- Postman v2.1 types (internal, for building collection items) ---

export interface PostmanCollection {
  info: {
    name: string;
    schema: string;
  };
  item: PostmanItem[];
}

export interface PostmanItem {
  name: string;
  request: {
    method: string;
    header: Array<{ key: string; value: string }>;
    url: {
      raw: string;
      host: string[];
      path: string[];
      query?: Array<{ key: string; value: string }>;
      variable?: Array<{ key: string; value: string }>;
    };
    body?: {
      mode: string;
      raw: string;
      options?: { raw: { language: string } };
    };
  };
  response: PostmanResponse[];
}

export interface PostmanResponse {
  name: string;
  originalRequest: PostmanItem['request'];
  status: string;
  code: number;
  header: Array<{ key: string; value: string }>;
  body: string;
}

// --- Diff types ---

export interface EndpointDiff {
  method: string;
  path: string;
  type: 'added' | 'removed' | 'changed';
  changes?: FieldChange[];
}

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

// --- CLI test execution types ---

export interface CliTestStep {
  name: string;
  method: string;
  url: string;
  status: 'passed' | 'failed' | 'skipped';
  statusCode?: number;
  duration?: number;
  assertions?: Array<{ name: string; passed: boolean; message?: string }>;
  error?: string;
}

export interface CliResult {
  exitCode: number;
  success: boolean;
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    duration: number;
  };
  steps: CliTestStep[];
  rawOutput: string;
}

// --- Schema management types ---

export interface SchemaInfo {
  name: string;
  type: string;
  propertyCount: number;
  referencedBy: string[];
}

// --- Coverage analysis types ---

export interface CoverageCategory {
  name: string;
  total: number;
  covered: number;
  percentage: number;
  missing: string[];
}

export interface CoverageReport {
  totalEndpoints: number;
  categories: CoverageCategory[];
  overallPercentage: number;
}

// --- Validation types ---

export type ValidationSeverity = 'error' | 'warning' | 'info';

export interface ValidationIssue {
  severity: ValidationSeverity;
  code: string;
  message: string;
  location?: string;
}

export interface ValidationReport {
  errors: number;
  warnings: number;
  info: number;
  issues: ValidationIssue[];
}

// --- Shared constants ---

export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;

// --- Lightweight endpoint ref (used by analysis/bulk/diff tools) ---

export interface EndpointRef {
  method: string;
  path: string;
  label: string;
}

export function allEndpoints(spec: OpenApiSpec): EndpointRef[] {
  const result: EndpointRef[] = [];
  for (const [path, methods] of Object.entries(spec.paths || {})) {
    for (const method of HTTP_METHODS) {
      if (methods[method]) result.push({ method, path, label: `${method.toUpperCase()} ${path}` });
    }
  }
  return result;
}

// --- Aggregate import counters helper ---

export function emptyCounters(): ApidogImportCounters {
  return {
    endpointCreated: 0, endpointUpdated: 0, endpointFailed: 0, endpointIgnored: 0,
    schemaCreated: 0, schemaUpdated: 0, schemaFailed: 0, schemaIgnored: 0,
    endpointFolderCreated: 0, endpointFolderUpdated: 0, endpointFolderFailed: 0, endpointFolderIgnored: 0,
    schemaFolderCreated: 0, schemaFolderUpdated: 0, schemaFolderFailed: 0, schemaFolderIgnored: 0,
  };
}

export function mergeCounters(a: ApidogImportCounters, b: ApidogImportCounters): ApidogImportCounters {
  const result = { ...a };
  for (const key of Object.keys(b) as Array<keyof ApidogImportCounters>) {
    result[key] += b[key];
  }
  return result;
}
