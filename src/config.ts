export interface Config {
  databaseUrl: string;
  apiKey: string;
  host: string;
  port: number;
  enableDocs: boolean;
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';
}

const allowedLevels = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('DATABASE_URL must use postgres: or postgresql:');
  }

  const apiKey = env.API_KEY ?? '';
  if (Buffer.byteLength(apiKey, 'utf8') < 32) {
    throw new Error('API_KEY must contain at least 32 bytes; generate a random secret');
  }

  const portText = env.PORT ?? '3000';
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  const level = env.LOG_LEVEL ?? 'info';
  if (!allowedLevels.has(level)) throw new Error('Invalid LOG_LEVEL');

  return {
    databaseUrl,
    apiKey,
    port,
    host: env.HOST ?? '127.0.0.1',
    enableDocs: (env.ENABLE_DOCS ?? 'false') === 'true' && env.NODE_ENV !== 'production',
    logLevel: level as Config['logLevel'],
  };
}
