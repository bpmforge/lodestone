// Secrets / config loading (concept: secrets_config).
export function loadApiKey(name: string): string {
  const value = readFromEnv(name);
  if (!value) {
    throw new Error(`missing secret: ${name}`);
  }
  return value;
}

export function loadConnectionString(): string {
  return readFromEnv("DATABASE_URL") ?? "";
}

function readFromEnv(name: string): string | undefined {
  return process.env[name];
}
