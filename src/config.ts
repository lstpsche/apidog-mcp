import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

export interface ProjectConfig {
  name: string;
  projectId: string;
  modules: Record<string, number>;
}

export interface Config {
  accessToken: string;
  projects: ProjectConfig[];
}

interface FileProjectEntry {
  name?: string;
  projectId?: string | number;
  modules?: Record<string, number>;
}

interface FileConfig {
  accessToken?: string;
  projectId?: string | number;
  modules?: Record<string, number>;
  projects?: FileProjectEntry[];
}

const ENV_DEFAULT_PROJECT = 'default';

function findConfigFile(): string | null {
  if (process.env.APIDOG_CONFIG_PATH) {
    return existsSync(process.env.APIDOG_CONFIG_PATH)
      ? process.env.APIDOG_CONFIG_PATH
      : null;
  }

  let dir = process.cwd();
  while (true) {
    const candidate = join(dir, '.apidog.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function loadFileConfig(): FileConfig | null {
  const filePath = findConfigFile();
  if (!filePath) return null;

  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as FileConfig;
  } catch {
    throw new Error(`.apidog.json exists but is not valid JSON (${filePath})`);
  }
}

function validateModules(modules: Record<string, number>, source: string): void {
  const invalid = Object.entries(modules).filter(([, v]) => typeof v !== 'number');
  if (invalid.length > 0) {
    throw new Error(`${source} module values must be numbers. Invalid: ${invalid.map(([k]) => k).join(', ')}`);
  }
}

function parseFileProjects(file: FileConfig): ProjectConfig[] {
  if (Array.isArray(file.projects) && file.projects.length > 0) {
    return file.projects.map((p, i) => {
      const name = p.name || `project-${i}`;
      const projectId = p.projectId != null ? String(p.projectId) : undefined;
      if (!projectId) throw new Error(`projects[${i}] ("${name}") is missing projectId`);

      const modules = p.modules ?? {};
      if (Object.keys(modules).length > 0) validateModules(modules, `projects[${i}] ("${name}")`);

      return { name, projectId, modules };
    });
  }

  if (file.projectId != null) {
    const modules = file.modules ?? {};
    if (Object.keys(modules).length > 0) validateModules(modules, '.apidog.json');
    return [{ name: ENV_DEFAULT_PROJECT, projectId: String(file.projectId), modules }];
  }

  return [];
}

function buildEnvProject(): ProjectConfig | null {
  const projectId = process.env.APIDOG_PROJECT_ID;
  if (!projectId) return null;

  let modules: Record<string, number> = {};
  if (process.env.APIDOG_MODULES) {
    try {
      modules = JSON.parse(process.env.APIDOG_MODULES);
    } catch {
      throw new Error('APIDOG_MODULES env must be valid JSON, e.g. {"api":123,"engine":456}');
    }
    validateModules(modules, 'APIDOG_MODULES env');
  }

  return { name: ENV_DEFAULT_PROJECT, projectId, modules };
}

export function loadConfig(): Config {
  const file = loadFileConfig();

  const accessToken = process.env.APIDOG_ACCESS_TOKEN || file?.accessToken;
  if (!accessToken) {
    throw new Error('accessToken is required — set APIDOG_ACCESS_TOKEN env or add "accessToken" to .apidog.json');
  }

  const fileProjects = file ? parseFileProjects(file) : [];
  const envProject = buildEnvProject();

  const projectMap = new Map<string, ProjectConfig>();
  for (const p of fileProjects) projectMap.set(p.name, p);
  if (envProject) projectMap.set(envProject.name, envProject);

  const projects = [...projectMap.values()];
  if (projects.length === 0) {
    throw new Error('At least one project is required — configure projects in .apidog.json or set APIDOG_PROJECT_ID env');
  }

  for (const p of projects) {
    if (Object.keys(p.modules).length === 0) {
      throw new Error(`Project "${p.name}" has no modules — add "modules" to its config or set APIDOG_MODULES env`);
    }
  }

  return { accessToken, projects };
}

export function resolveProject(config: Config, name?: string): ProjectConfig {
  if (!name) {
    if (config.projects.length === 1) return config.projects[0];
    const available = config.projects.map(p => p.name).join(', ');
    throw new Error(`Multiple projects configured — specify "project" param. Available: ${available}`);
  }

  const project = config.projects.find(p => p.name === name);
  if (!project) {
    const available = config.projects.map(p => p.name).join(', ');
    throw new Error(`Unknown project "${name}". Available: ${available}`);
  }
  return project;
}

export function resolveModule(project: ProjectConfig, name: string): number {
  const moduleId = project.modules[name];
  if (moduleId === undefined) {
    const available = Object.keys(project.modules).join(', ');
    throw new Error(`Unknown module "${name}" in project "${project.name}". Available: ${available}`);
  }
  return moduleId;
}
