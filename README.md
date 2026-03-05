# @lstpsche/apidog-mcp

MCP server for managing [Apidog](https://apidog.com) API documentation. Provides 22 tools for importing, exporting, diffing, analyzing, and bulk-editing OpenAPI specs and endpoint cases via the Model Context Protocol.

## Quick Start

```bash
npx @lstpsche/apidog-mcp
```

## Configuration

Add to your MCP client config (e.g. `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "apidog": {
      "command": "npx",
      "args": ["-y", "@lstpsche/apidog-mcp"],
      "env": {
        "APIDOG_ACCESS_TOKEN": "<your-apidog-personal-access-token>",
        "APIDOG_PROJECT_ID": "<your-project-id>",
        "APIDOG_MODULES": "{\"backend\":1234,\"payments\":5678}"
      }
    }
  }
}
```

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `APIDOG_ACCESS_TOKEN` | Yes | Apidog personal access token |
| `APIDOG_PROJECT_ID` | Yes | Apidog project ID |
| `APIDOG_MODULES` | Yes | JSON map of module names to Apidog module IDs |

Get your access token from Apidog > Account Settings > API Access Tokens.
Find module IDs in each module's settings page within your Apidog project.

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

## Multi-Module Architecture

A single server instance manages multiple Apidog modules. Pass the module name (e.g. `"backend"`, `"payments"`) to each tool call — the server resolves it to the correct module ID from `APIDOG_MODULES`.

## License

[MIT](LICENSE)
