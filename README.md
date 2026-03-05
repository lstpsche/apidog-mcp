# @lstpsche/apidog-mcp

MCP server for managing [Apidog](https://apidog.com) API documentation. Provides 22 tools for importing, exporting, diffing, analyzing, and bulk-editing OpenAPI specs and endpoint cases via the Model Context Protocol.

## Quick Start

```bash
npx @lstpsche/apidog-mcp
```

## Configuration

### Option A: Project-level config file (recommended)

Create `.apidog.json` in your project root:

```json
{
  "accessToken": "adgp_your_token_here",
  "projectId": "1234567",
  "modules": {
    "backend": 1234,
    "payments": 5678
  }
}
```

Add `.apidog.json` to your `.gitignore` to keep secrets out of version control.

Then configure your MCP client (e.g. `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "apidog": {
      "command": "npx",
      "args": ["-y", "@lstpsche/apidog-mcp"]
    }
  }
}
```

### Option B: Environment variables

Set these in your shell or CI environment:

| Variable | Description |
|---|---|
| `APIDOG_ACCESS_TOKEN` | Apidog personal access token |
| `APIDOG_PROJECT_ID` | Apidog project ID |
| `APIDOG_MODULES` | JSON map of module names to IDs (e.g. `{"api":123}`) |

```json
{
  "mcpServers": {
    "apidog": {
      "command": "npx",
      "args": ["-y", "@lstpsche/apidog-mcp"],
      "env": {
        "APIDOG_ACCESS_TOKEN": "${APIDOG_ACCESS_TOKEN}",
        "APIDOG_PROJECT_ID": "${APIDOG_PROJECT_ID}",
        "APIDOG_MODULES": "${APIDOG_MODULES}"
      }
    }
  }
}
```

### Resolution order

Environment variables take precedence over `.apidog.json`. You can mix both — for example, keep `projectId` and `modules` in `.apidog.json` and set `APIDOG_ACCESS_TOKEN` via environment for security.

### Where to find your credentials

- **Access Token**: Apidog > Account Settings > API Access Tokens
- **Project ID**: Open your project > Settings > Basic Settings
- **Module IDs**: Each module's settings page within your Apidog project

## Tools (22)

### Read

| Tool | Description |
|---|---|
| `apidog_modules` | List configured modules with names and IDs |
| `apidog_export` | Export full OpenAPI spec for a module |
| `apidog_list` | List/search endpoints with filters and pagination |
| `apidog_get` | Get full details of a single endpoint |
| `apidog_folders` | Analyze folder structure and counts |

### Write

| Tool | Description |
|---|---|
| `apidog_import_openapi` | Import OpenAPI spec (auto-batched for large specs) |
| `apidog_wipe` | Wipe all endpoints in a module (requires confirm) |
| `apidog_update` | Update a single endpoint via partial spec import |
| `apidog_delete` | Delete an endpoint |
| `apidog_pipeline` | 3-step pipeline: wipe, create cases, overlay spec |

### Cases

| Tool | Description |
|---|---|
| `apidog_create_cases` | Create endpoint usage examples (single or batch) |

### Diff & Analysis

| Tool | Description |
|---|---|
| `apidog_diff` | Compare Apidog state against a local spec |
| `apidog_analyze` | Coverage and validation analysis (selectable checks) |

### Schemas

| Tool | Description |
|---|---|
| `apidog_list_schemas` | List component schemas with references |
| `apidog_get_schema` | Get full schema definition |
| `apidog_update_schema` | Create or update a component schema |
| `apidog_delete_schema` | Delete a schema (refuses if still referenced) |

### Bulk Operations

| Tool | Description |
|---|---|
| `apidog_bulk_update` | Batch update tags, folders, status, summaries |

### Export Formats

| Tool | Description |
|---|---|
| `apidog_export_markdown` | Export as Markdown documentation |
| `apidog_export_curl` | Export as curl command examples |
| `apidog_export_postman` | Export as Postman Collection v2.1 |

### Testing

| Tool | Description |
|---|---|
| `apidog_run_test` | Run test scenarios or folders via Apidog CLI |

## Limitations

Apidog's public API is limited in scope. The following functionality is **not available** through this MCP server due to missing API support:

| Feature | Reason |
|---|---|
| **Direct endpoint CRUD** | No REST API for creating/updating/deleting individual endpoints. Workaround: OpenAPI spec import with matching options. |
| **Endpoint case CRUD** | No API for creating/editing endpoint cases directly. Workaround: Postman collection import to inject cases. |
| **Auto-generated "Success" case suppression** | `autoGenerateCase: false` is silently ignored by the API. Workaround: auto-generated empty cases are detected and replaced after import. |
| **Folder/module management** | No API to create, rename, or delete folders or modules. Workaround: `x-apidog-folder` extension in OpenAPI import controls folder placement. |
| **Test scenario management** | No API to create or edit test scenarios. Only execution of existing scenarios is supported via `apidog-cli`. |
| **Test execution auth** | `apidog-cli` requires a separate CI/CD access token generated from within a test scenario's settings, not the general API access token. |
| **Environment variables** | No API to manage Apidog environment variables. |
| **Mock server configuration** | No API to configure or control mock servers. |
| **Comments and discussions** | No API to read or post comments on endpoints. |
| **Change history** | No API to access endpoint revision history. |

These limitations are inherent to the Apidog API as of March 2026. The MCP server implements workarounds where possible (noted above).

## Multi-Module Architecture

A single server instance manages multiple Apidog modules. Pass the module name (e.g. `"backend"`, `"payments"`) to each tool call — the server resolves it to the correct module ID from `APIDOG_MODULES`.

## License

[MIT](LICENSE)
