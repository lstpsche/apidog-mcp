export interface Config {
  accessToken: string;
  projectId: string;
  modules: Record<string, number>;
}

export function loadConfig(): Config {
  const accessToken = process.env.APIDOG_ACCESS_TOKEN;
  const projectId = process.env.APIDOG_PROJECT_ID;
  const modulesRaw = process.env.APIDOG_MODULES;

  if (!accessToken) throw new Error('APIDOG_ACCESS_TOKEN env is required');
  if (!projectId) throw new Error('APIDOG_PROJECT_ID env is required');
  if (!modulesRaw) throw new Error('APIDOG_MODULES env is required (JSON map of name→moduleId)');

  let modules: Record<string, number>;
  try {
    modules = JSON.parse(modulesRaw);
  } catch {
    throw new Error('APIDOG_MODULES must be valid JSON, e.g. {"api":123,"engine":456}');
  }

  const invalidEntries = Object.entries(modules).filter(([, v]) => typeof v !== 'number');
  if (invalidEntries.length > 0) {
    throw new Error(`APIDOG_MODULES values must be numbers. Invalid: ${invalidEntries.map(([k]) => k).join(', ')}`);
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
