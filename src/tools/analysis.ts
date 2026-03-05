import type { ApidogClient } from '../client.js';
import { HTTP_METHODS, allEndpoints } from '../types.js';
import type { OpenApiSpec, EndpointRef, CoverageCategory, CoverageReport, ValidationIssue, ValidationReport } from '../types.js';

const BODY_METHODS = new Set(['post', 'put', 'patch']);

type CheckType = 'coverage' | 'validate';

function coverageCategory(
  name: string,
  endpoints: EndpointRef[],
  spec: OpenApiSpec,
  check: (method: string, path: string, op: Record<string, unknown>) => boolean,
): CoverageCategory {
  const missing: string[] = [];
  for (const ep of endpoints) {
    const op = spec.paths[ep.path]?.[ep.method];
    if (!op || !check(ep.method, ep.path, op)) missing.push(ep.label);
  }
  const total = endpoints.length;
  const covered = total - missing.length;
  return {
    name,
    total,
    covered,
    percentage: total > 0 ? Math.round((covered / total) * 100) : 100,
    missing,
  };
}

function buildCoverageReport(spec: OpenApiSpec, eps: EndpointRef[]): CoverageReport {
  const categories: CoverageCategory[] = [
    coverageCategory('summary', eps, spec, (_m, _p, op) =>
      typeof op.summary === 'string' && op.summary.trim().length > 0),

    coverageCategory('description', eps, spec, (_m, _p, op) =>
      typeof op.description === 'string' && op.description.trim().length > 0),

    coverageCategory('operationId', eps, spec, (_m, _p, op) =>
      typeof op.operationId === 'string' && op.operationId.trim().length > 0),

    coverageCategory('tags', eps, spec, (_m, _p, op) =>
      Array.isArray(op.tags) && op.tags.length > 0),

    coverageCategory('responses', eps, spec, (_m, _p, op) => {
      const responses = op.responses as Record<string, unknown> | undefined;
      if (!responses) return false;
      const codes = Object.keys(responses);
      return codes.some(c => c !== 'default');
    }),

    coverageCategory('requestBody (POST/PUT/PATCH)', eps.filter(e => BODY_METHODS.has(e.method)), spec, (_m, _p, op) =>
      op.requestBody !== undefined && op.requestBody !== null),

    coverageCategory('response examples', eps, spec, (_m, _p, op) => {
      const responses = op.responses as Record<string, Record<string, unknown>> | undefined;
      if (!responses) return false;
      return Object.values(responses).some(resp => {
        const content = resp.content as Record<string, { example?: unknown }> | undefined;
        if (!content) return false;
        return Object.values(content).some(ct => ct.example !== undefined);
      });
    }),
  ];

  const totalChecks = categories.reduce((sum, c) => sum + c.total, 0);
  const totalCovered = categories.reduce((sum, c) => sum + c.covered, 0);

  return {
    totalEndpoints: eps.length,
    categories,
    overallPercentage: totalChecks > 0 ? Math.round((totalCovered / totalChecks) * 100) : 100,
  };
}

function buildValidationReport(spec: OpenApiSpec, eps: EndpointRef[]): ValidationReport {
  const issues: ValidationIssue[] = [];

  const opIds = new Map<string, string[]>();
  for (const ep of eps) {
    const op = spec.paths[ep.path]?.[ep.method];
    if (op?.operationId) {
      const id = op.operationId as string;
      if (!opIds.has(id)) opIds.set(id, []);
      opIds.get(id)!.push(ep.label);
    }
  }
  for (const [id, endpoints] of opIds) {
    if (endpoints.length > 1) {
      issues.push({
        severity: 'error',
        code: 'DUPLICATE_OPERATION_ID',
        message: `operationId "${id}" used by ${endpoints.length} endpoints: ${endpoints.join(', ')}`,
      });
    }
  }

  const allSchemas = Object.keys(spec.components?.schemas ?? {});
  const specStr = JSON.stringify(spec.paths || {});
  const componentStr = JSON.stringify(spec.components?.schemas ?? {});
  for (const name of allSchemas) {
    if (!specStr.includes(`"#/components/schemas/${name}"`)) {
      const selfRef = `"#/components/schemas/${name}"`;
      const otherRefs = componentStr.split(selfRef).length - 1;
      if (otherRefs <= 1) {
        issues.push({
          severity: 'warning',
          code: 'ORPHANED_SCHEMA',
          message: `Schema "${name}" is defined but not referenced by any endpoint`,
        });
      }
    }
  }

  for (const ep of eps) {
    const op = spec.paths[ep.path]?.[ep.method];
    if (!op) continue;

    const pathParams = [...ep.path.matchAll(/\{([^}]+)\}/g)].map(m => m[1]);
    const definedParams = Array.isArray(op.parameters)
      ? (op.parameters as Array<{ in?: string; name?: string }>)
          .filter(p => p.in === 'path')
          .map(p => p.name)
      : [];

    for (const param of pathParams) {
      if (!definedParams.includes(param)) {
        issues.push({
          severity: 'error',
          code: 'MISSING_PATH_PARAM',
          message: `Path parameter "{${param}}" in ${ep.label} has no parameter definition`,
          location: ep.label,
        });
      }
    }
  }

  for (const ep of eps) {
    const op = spec.paths[ep.path]?.[ep.method];
    if (!op) continue;

    if (typeof op.summary === 'string' && op.summary.trim() === '') {
      issues.push({
        severity: 'info',
        code: 'EMPTY_SUMMARY',
        message: `${ep.label} has an empty summary field`,
        location: ep.label,
      });
    }
    if (typeof op.description === 'string' && op.description.trim() === '') {
      issues.push({
        severity: 'info',
        code: 'EMPTY_DESCRIPTION',
        message: `${ep.label} has an empty description field`,
        location: ep.label,
      });
    }
  }

  const definedTags = new Set((spec.tags ?? []).map(t => t.name));
  const usedTags = new Set<string>();
  for (const ep of eps) {
    const op = spec.paths[ep.path]?.[ep.method];
    if (Array.isArray(op?.tags)) {
      for (const t of op.tags as string[]) usedTags.add(t);
    }
  }
  for (const tag of usedTags) {
    if (!definedTags.has(tag)) {
      issues.push({
        severity: 'warning',
        code: 'UNDECLARED_TAG',
        message: `Tag "${tag}" is used in operations but not declared in top-level tags array`,
      });
    }
  }
  for (const tag of definedTags) {
    if (!usedTags.has(tag)) {
      issues.push({
        severity: 'info',
        code: 'UNUSED_TAG',
        message: `Tag "${tag}" is declared but not used by any operation`,
      });
    }
  }

  for (const ep of eps) {
    const op = spec.paths[ep.path]?.[ep.method];
    const responses = op?.responses as Record<string, Record<string, unknown>> | undefined;
    if (!responses) continue;

    for (const [code, resp] of Object.entries(responses)) {
      if (!resp.description || (typeof resp.description === 'string' && resp.description.trim() === '')) {
        issues.push({
          severity: 'warning',
          code: 'RESPONSE_NO_DESCRIPTION',
          message: `${ep.label} response ${code} has no description`,
          location: ep.label,
        });
      }
    }
  }

  issues.sort((a, b) => {
    const sev = { error: 0, warning: 1, info: 2 };
    return sev[a.severity] - sev[b.severity];
  });

  return {
    errors: issues.filter(i => i.severity === 'error').length,
    warnings: issues.filter(i => i.severity === 'warning').length,
    info: issues.filter(i => i.severity === 'info').length,
    issues,
  };
}

// --- apidog_analyze (coverage + validate, selectable via checks) ---

export async function handleAnalyze(
  client: ApidogClient,
  moduleId: number,
  args: { checks?: string[] },
): Promise<string> {
  const allChecks: CheckType[] = ['coverage', 'validate'];
  const requested: CheckType[] = args.checks?.length
    ? args.checks.filter((c): c is CheckType => allChecks.includes(c as CheckType))
    : allChecks;

  if (requested.length === 0) {
    return JSON.stringify({ error: `Invalid checks. Must include one or more of: ${allChecks.join(', ')}` });
  }

  const spec = await client.exportSpec(moduleId, { includeExtensions: true });
  const eps = allEndpoints(spec);

  const result: Record<string, unknown> = {};

  if (requested.includes('coverage')) {
    result.coverage = buildCoverageReport(spec, eps);
  }

  if (requested.includes('validate')) {
    result.validation = buildValidationReport(spec, eps);
  }

  return JSON.stringify(result, null, 2);
}
