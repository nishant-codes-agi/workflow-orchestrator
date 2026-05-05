import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../../src/config.js';

describe('loadConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env['PORT'] = '3000';
    process.env['DATABASE_URL'] = 'postgres://user:pass@localhost:5432/testdb';
    process.env['WORKER_COUNT'] = '10';
    process.env['HEARTBEAT_INTERVAL_MS'] = '5000';
    process.env['REAPER_POLL_MS'] = '30000';
    process.env['LEASE_TIMEOUT_MS'] = '15000';
    process.env['CRON_TICK_MS'] = '10000';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('parses valid env vars into config', () => {
    const config = loadConfig();
    expect(config.port).toBe(3000);
    expect(config.databaseUrl).toBe('postgres://user:pass@localhost:5432/testdb');
    expect(config.workerCount).toBe(10);
    expect(config.heartbeatIntervalMs).toBe(5000);
    expect(config.reaperPollMs).toBe(30000);
    expect(config.leaseTimeoutMs).toBe(15000);
    expect(config.cronTickMs).toBe(10000);
  });

  it('throws when PORT is missing', () => {
    delete process.env['PORT'];
    expect(() => loadConfig()).toThrow('Missing required environment variable: PORT');
  });

  it('throws when DATABASE_URL is missing', () => {
    delete process.env['DATABASE_URL'];
    expect(() => loadConfig()).toThrow('Missing required environment variable: DATABASE_URL');
  });

  it('throws when WORKER_COUNT is missing', () => {
    delete process.env['WORKER_COUNT'];
    expect(() => loadConfig()).toThrow('Missing required environment variable: WORKER_COUNT');
  });

  it('throws when PORT is not an integer', () => {
    process.env['PORT'] = 'abc';
    expect(() => loadConfig()).toThrow('must be an integer');
  });

  it('throws when env var is empty string', () => {
    process.env['DATABASE_URL'] = '';
    expect(() => loadConfig()).toThrow('Missing required environment variable: DATABASE_URL');
  });
});
