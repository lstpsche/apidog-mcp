import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface Config {
  accessToken: string;
  projectId: string;
  modules: Record<string, number>;
}

interface FileConfig {
  accessToken?: string;
  projectId?: string | number;
  modules?: Record<string, number>;
}

function loadFileConfig(): FileConfig | null {
  const filePath = join(process.cwd(), '.apidog.json');
  if (!existsSync(filePath)) return null;

  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as FileConfig;
  } catch {
    throw new Error(`.apidog.json exists but is not valid JSON`);
  }
}

function validateModules(modules: Record<string, number>, source: string): void {
  const invalid = Object.entries(modules).filter(([, v]) => typeof v !== 'number');
  if (invalid.length > 0) {
    throw new Error(`${source} module values must be numbers. Invalid: ${invalid.map(([k]) => k).join(', ')}`);
  }
}

export function loadConfig(): Config {
  const file = loadFileConfig();

  const accessToken = process.env.APIDOG_ACCESS_TOKEN || file?.accessToken;
  const projectId = process.env.APIDOG_PROJECT_ID || (file?.projectId != null ? String(file.projectId) : undefined);

  let modules: Record<string, number> | undefined;
  if (process.env.APIDOG_MODULES) {
    try {
      modules = JSON.parse(process.env.APIDOG_MODULES);
    } catch {
      throw new Error('APIDOG_MODULES env must be valid JSON, e.g. {"api":123,"engine":456}');
    }
    validateModules(modules!, 'APIDOG_MODULES env');
  } else if (file?.modules) {
    modules = file.modules;
    validateModules(modules, '.apidog.json');
  }

  if (!accessToken) {
    throw new Error('accessToken is required — set APIDOG_ACCESS_TOKEN env or add "accessToken" to .apidog.json');
  }
  if (!projectId) {
    throw new Error('projectId is required — set APIDOG_PROJECT_ID env or add "projectId" to .apidog.json');
  }
  if (!modules || Object.keys(modules).length === 0) {
    throw new Error('modules are required — set APIDOG_MODULES env or add "modules" to .apidog.json');
  }

  return { accessToken, projectId, modules };
}

export function resolveModule(config: Config, name: string): number {
  const moduleId = config.modules[name];
  if (moduleId === undefined) {
    const available = Object.keys(config.modules).join(', ');
    throw new Error(`Unknown module "${name}". Available: ${available}`);
  }
  return moduleId;
}
