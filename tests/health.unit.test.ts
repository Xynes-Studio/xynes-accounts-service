import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { Hono } from 'hono';

describe('Health endpoint (unit)', () => {
  let app: Hono;

  beforeEach(async () => {
    // Dynamic import to get fresh module
    const { healthRoute } = await import('../src/routes/health.route');
    app = new Hono();
    app.route('/health', healthRoute);
  });

  it('GET /health returns 200 with status ok', async () => {
    const res = await app.request('/health');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('xynes-accounts-service');
  });

  it('GET /health returns JSON content-type', async () => {
    const res = await app.request('/health');

    expect(res.headers.get('content-type')).toContain('application/json');
  });
});

describe('Ready endpoint (unit)', () => {
  it('GET /ready returns 200 when DB is healthy', async () => {
    // Mock the readiness check to succeed
    const mockCheck = mock(() => Promise.resolve());

    const { createGetReady } = await import('../src/controllers/ready.controller');
    const getReady = createGetReady({
      getDatabaseUrl: () => 'postgres://test:test@localhost:5432/test',
      check: mockCheck,
      schemaName: 'identity',
    });

    const app = new Hono();
    app.get('/ready', getReady);

    const res = await app.request('/ready');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ready');
    expect(mockCheck).toHaveBeenCalled();
  });

  it('GET /ready returns 503 when DB check fails', async () => {
    // Mock the readiness check to fail
    const mockCheck = mock(() => Promise.reject(new Error('Connection refused')));

    const { createGetReady } = await import('../src/controllers/ready.controller');
    const getReady = createGetReady({
      getDatabaseUrl: () => 'postgres://test:test@localhost:5432/test',
      check: mockCheck,
      schemaName: 'identity',
    });

    const app = new Hono();
    app.get('/ready', getReady);

    const res = await app.request('/ready');

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe('not_ready');
  });

  it('GET /ready checks identity schema by default', async () => {
    const mockCheck = mock(() => Promise.resolve());

    const { createGetReady } = await import('../src/controllers/ready.controller');
    const getReady = createGetReady({
      getDatabaseUrl: () => 'postgres://test',
      check: mockCheck,
    });

    const app = new Hono();
    app.get('/ready', getReady);

    await app.request('/ready');

    expect(mockCheck).toHaveBeenCalledWith({
      databaseUrl: 'postgres://test',
      schemaName: 'identity',
    });
  });
});
