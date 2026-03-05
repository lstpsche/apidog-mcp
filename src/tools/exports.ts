import type { ApidogClient } from '../client.js';
import { HTTP_METHODS } from '../types.js';
import type { OpenApiSpec, PostmanItem, PostmanResponse } from '../types.js';

interface EndpointInfo {
  method: string;
  path: string;
  summary?: string;
  description?: string;
  tags: string[];
  folder: string | null;
  parameters: Array<{ name: string; in: string; required?: boolean; description?: string; type?: string }>;
  requestBody?: { contentType: string; schema?: unknown };
  responses: Array<{ code: string; description?: string; schema?: unknown }>;
}

function extractEndpoints(spec: OpenApiSpec): EndpointInfo[] {
  const result: EndpointInfo[] = [];

  for (const [path, methods] of Object.entries(spec.paths || {})) {
    for (const method of HTTP_METHODS) {
      const op = methods[method];
      if (!op) continue;

      const params = Array.isArray(op.parameters)
        ? (op.parameters as Array<Record<string, unknown>>).map(p => ({
            name: String(p.name ?? ''),
            in: String(p.in ?? ''),
            required: p.required as boolean | undefined,
            description: p.description as string | undefined,
            type: p.schema ? schemaToType(p.schema) : undefined,
          }))
        : [];

      let requestBody: EndpointInfo['requestBody'];
      if (op.requestBody && typeof op.requestBody === 'object') {
        const rb = op.requestBody as Record<string, unknown>;
        const content = rb.content as Record<string, { schema?: unknown }> | undefined;
        if (content) {
          const ct = Object.keys(content)[0] ?? 'application/json';
          requestBody = { contentType: ct, schema: content[ct]?.schema };
        }
      }

      const responses: EndpointInfo['responses'] = [];
      if (op.responses && typeof op.responses === 'object') {
        for (const [code, resp] of Object.entries(op.responses as Record<string, Record<string, unknown>>)) {
          const content = resp.content as Record<string, { schema?: unknown }> | undefined;
          responses.push({
            code,
            description: resp.description as string | undefined,
            schema: content ? Object.values(content)[0]?.schema : undefined,
          });
        }
      }

      result.push({
        method: method.toUpperCase(),
        path,
        summary: op.summary,
        description: op.description,
        tags: op.tags ?? [],
        folder: op['x-apidog-folder'] ?? null,
        parameters: params,
        requestBody,
        responses,
      });
    }
  }
  return result;
}

function schemaToType(schema: unknown): string {
  if (!schema || typeof schema !== 'object') return 'unknown';
  const s = schema as Record<string, unknown>;
  if (s.$ref) return String(s.$ref).replace('#/components/schemas/', '');
  if (s.type === 'array') {
    const items = s.items as Record<string, unknown> | undefined;
    return `${schemaToType(items)}[]`;
  }
  return String(s.type ?? 'object');
}

// --- apidog_export_markdown ---

export async function handleExportMarkdown(
  client: ApidogClient,
  moduleId: number,
  args: { groupBy?: string; includeSchemas?: boolean },
): Promise<string> {
  const spec = await client.exportSpec(moduleId, { includeExtensions: true });
  const endpoints = extractEndpoints(spec);
  const groupBy = args.groupBy === 'tag' ? 'tag' : 'folder';

  const groups = new Map<string, EndpointInfo[]>();

  for (const ep of endpoints) {
    if (groupBy === 'tag') {
      const tags = ep.tags.length > 0 ? ep.tags : ['Untagged'];
      for (const tag of tags) {
        if (!groups.has(tag)) groups.set(tag, []);
        groups.get(tag)!.push(ep);
      }
    } else {
      const folder = ep.folder ?? 'Uncategorized';
      if (!groups.has(folder)) groups.set(folder, []);
      groups.get(folder)!.push(ep);
    }
  }

  let md = `# ${spec.info.title} API Documentation\n\n`;
  if (spec.info.description) md += `${spec.info.description}\n\n`;
  md += `**Version:** ${spec.info.version}\n\n`;
  md += `---\n\n`;

  for (const [groupName, eps] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    md += `## ${groupName}\n\n`;

    for (const ep of eps) {
      md += `### \`${ep.method} ${ep.path}\`\n\n`;
      if (ep.summary) md += `**${ep.summary}**\n\n`;
      if (ep.description) md += `${ep.description}\n\n`;

      if (ep.parameters.length > 0) {
        md += `**Parameters:**\n\n`;
        md += `| Name | In | Type | Required | Description |\n`;
        md += `|------|----|------|----------|-------------|\n`;
        for (const p of ep.parameters) {
          md += `| ${p.name} | ${p.in} | ${p.type ?? '-'} | ${p.required ? 'Yes' : 'No'} | ${p.description ?? '-'} |\n`;
        }
        md += `\n`;
      }

      if (ep.requestBody) {
        md += `**Request Body** (\`${ep.requestBody.contentType}\`):\n\n`;
        if (ep.requestBody.schema) {
          md += `\`\`\`json\n${JSON.stringify(ep.requestBody.schema, null, 2)}\n\`\`\`\n\n`;
        }
      }

      if (ep.responses.length > 0) {
        md += `**Responses:**\n\n`;
        for (const resp of ep.responses) {
          md += `- **${resp.code}**: ${resp.description ?? 'No description'}\n`;
        }
        md += `\n`;
      }

      md += `---\n\n`;
    }
  }

  if (args.includeSchemas && spec.components?.schemas) {
    md += `## Schemas\n\n`;
    for (const [name, def] of Object.entries(spec.components.schemas)) {
      md += `### ${name}\n\n`;
      md += `\`\`\`json\n${JSON.stringify(def, null, 2)}\n\`\`\`\n\n`;
    }
  }

  return JSON.stringify({
    format: 'markdown',
    length: md.length,
    endpointCount: endpoints.length,
    groupCount: groups.size,
    content: md,
  }, null, 2);
}

// --- apidog_export_curl ---

export async function handleExportCurl(
  client: ApidogClient,
  moduleId: number,
  args: {
    baseUrl: string;
    filterPath?: string;
    filterTag?: string;
    filterMethod?: string;
    includeHeaders?: Record<string, string>;
  },
): Promise<string> {
  const spec = await client.exportSpec(moduleId, { includeExtensions: true });
  let endpoints = extractEndpoints(spec);

  if (args.filterPath) endpoints = endpoints.filter(e => e.path.includes(args.filterPath!));
  if (args.filterTag) endpoints = endpoints.filter(e => e.tags.includes(args.filterTag!));
  if (args.filterMethod) endpoints = endpoints.filter(e => e.method.toLowerCase() === args.filterMethod!.toLowerCase());

  const baseUrl = args.baseUrl.replace(/\/$/, '');
  const commands: Array<{ endpoint: string; curl: string }> = [];

  for (const ep of endpoints) {
    let url = `${baseUrl}${ep.path}`;

    // Replace path params with placeholders
    url = url.replace(/\{([^}]+)\}/g, ':$1');

    const parts = [`curl -X ${ep.method}`];

    parts.push(`  '${url}'`);

    // Default headers
    parts.push(`  -H 'Content-Type: application/json'`);
    if (args.includeHeaders) {
      for (const [key, value] of Object.entries(args.includeHeaders)) {
        parts.push(`  -H '${key}: ${value}'`);
      }
    }

    // Query params as placeholders
    const queryParams = ep.parameters.filter(p => p.in === 'query');
    if (queryParams.length > 0) {
      const qs = queryParams.map(p => `${p.name}=<${p.type ?? 'value'}>`).join('&');
      parts[1] = `  '${url}?${qs}'`;
    }

    // Request body placeholder
    if (ep.requestBody?.schema) {
      const placeholder = generatePlaceholder(ep.requestBody.schema);
      parts.push(`  -d '${JSON.stringify(placeholder)}'`);
    }

    commands.push({
      endpoint: `${ep.method} ${ep.path}`,
      curl: parts.join(' \\\n'),
    });
  }

  return JSON.stringify({
    baseUrl,
    total: commands.length,
    commands,
  }, null, 2);
}

function generatePlaceholder(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return '<value>';
  const s = schema as Record<string, unknown>;

  if (s.$ref) return `<${String(s.$ref).replace('#/components/schemas/', '')}>`;

  if (s.type === 'object' && s.properties && typeof s.properties === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, prop] of Object.entries(s.properties as Record<string, unknown>)) {
      result[key] = generatePlaceholder(prop);
    }
    return result;
  }

  if (s.type === 'array') return [generatePlaceholder(s.items)];
  if (s.type === 'string') return s.example ?? '<string>';
  if (s.type === 'integer' || s.type === 'number') return s.example ?? 0;
  if (s.type === 'boolean') return s.example ?? false;

  return '<value>';
}

// --- apidog_export_postman ---

export async function handleExportPostman(
  client: ApidogClient,
  moduleId: number,
  args: { baseUrl?: string },
): Promise<string> {
  const spec = await client.exportSpec(moduleId, { includeExtensions: true });
  const endpoints = extractEndpoints(spec);
  const baseUrlVar = args.baseUrl ?? '{{base_url}}';

  const folderMap = new Map<string, PostmanItem[]>();

  for (const ep of endpoints) {
    const folder = ep.folder ?? 'Uncategorized';
    if (!folderMap.has(folder)) folderMap.set(folder, []);

    const postmanPath = ep.path.replace(/\{([^}]+)\}/g, ':$1');
    const pathSegments = postmanPath.replace(/^\//, '').split('/');
    const pathParamNames = [...postmanPath.matchAll(/:([a-zA-Z_][a-zA-Z0-9_]*)/g)].map(m => m[1]);

    const header = [{ key: 'Content-Type', value: 'application/json' }];
    const query = ep.parameters
      .filter(p => p.in === 'query')
      .map(p => ({ key: p.name, value: `<${p.type ?? 'value'}>` }));
    const variable = pathParamNames.map(name => ({ key: name, value: `<${name}>` }));

    const request: PostmanItem['request'] = {
      method: ep.method,
      header,
      url: {
        raw: `${baseUrlVar}${postmanPath}`,
        host: [baseUrlVar],
        path: pathSegments,
        ...(query.length > 0 && { query }),
        ...(variable.length > 0 && { variable }),
      },
    };

    if (ep.requestBody?.schema) {
      const placeholder = generatePlaceholder(ep.requestBody.schema);
      request.body = {
        mode: 'raw',
        raw: JSON.stringify(placeholder, null, 2),
        options: { raw: { language: 'json' } },
      };
    }

    const responses: PostmanResponse[] = ep.responses.map(resp => ({
      name: `${resp.code} ${resp.description ?? ''}`.trim(),
      originalRequest: request,
      status: resp.description ?? `Status ${resp.code}`,
      code: parseInt(resp.code, 10) || 0,
      header: [{ key: 'Content-Type', value: 'application/json' }],
      body: resp.schema ? JSON.stringify(generatePlaceholder(resp.schema), null, 2) : '',
    }));

    folderMap.get(folder)!.push({
      name: ep.summary ?? `${ep.method} ${ep.path}`,
      request,
      response: responses,
    });
  }

  // Build collection with folder structure
  const topItems: unknown[] = [];
  for (const [folderName, items] of [...folderMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (folderName === 'Uncategorized' && folderMap.size === 1) {
      topItems.push(...items);
    } else {
      topItems.push({ name: folderName, item: items });
    }
  }

  const collection = {
    info: {
      name: spec.info.title,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: topItems,
  };

  return JSON.stringify({
    format: 'postman_collection_v2.1',
    endpointCount: endpoints.length,
    folderCount: folderMap.size,
    collection,
  }, null, 2);
}
