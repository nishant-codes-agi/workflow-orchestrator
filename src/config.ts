import dotenv from 'dotenv';

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function requireIntEnv(name: string): number {
  const raw = requireEnv(name);
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got: ${raw}`);
  }
  return parsed;
}

export interface Config {
  port: number;
  databaseUrl: string;
  workerCount: number;
  heartbeatIntervalMs: number;
  reaperPollMs: number;
  leaseTimeoutMs: number;
  cronTickMs: number;
}

export function loadConfig(): Config {
  return {
    port: requireIntEnv('PORT'),
    databaseUrl: requireEnv('DATABASE_URL'),
    workerCount: requireIntEnv('WORKER_COUNT'),
    heartbeatIntervalMs: requireIntEnv('HEARTBEAT_INTERVAL_MS'),
    reaperPollMs: requireIntEnv('REAPER_POLL_MS'),
    leaseTimeoutMs: requireIntEnv('LEASE_TIMEOUT_MS'),
    cronTickMs: requireIntEnv('CRON_TICK_MS'),
  };
}
