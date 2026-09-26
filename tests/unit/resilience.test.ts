// Throttling and cancellation: one retry of a throttled GET, never of a POST, typed error codes for
// what still fails, and an aborted call that stops issuing requests.

import { MockAgent, setGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runWithContext } from '../../src/context.js';
import { handleCalmCreate } from '../../src/tools/calmCreate.js';
import { handleCalmGet } from '../../src/tools/calmGet.js';
import { makeClients, ORIGIN, parse } from './helpers.js';

const TASK = '/api/calm-tasks/v1/tasks/t1';

describe('throttling and cancellation', () => {
  let agent: MockAgent;
  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    await agent.close();
  });

  it('retries a throttled GET once after Retry-After', async () => {
    const pool = agent.get(ORIGIN);
    pool.intercept({ path: TASK }).reply(429, 'slow down', { headers: { 'retry-after': '0' } });
    pool.intercept({ path: TASK }).reply(200, { id: 't1' });
    const result = await handleCalmGet(makeClients(), { resource: 'task', id: 't1' });
    expect(parse(result)).toEqual({ id: 't1' });
  });

  it('reports RATE_LIMITED when throttled twice', async () => {
    const pool = agent.get(ORIGIN);
    pool.intercept({ path: TASK }).reply(503, 'busy', { headers: { 'retry-after': '0' } });
    pool.intercept({ path: TASK }).reply(429, 'busy', { headers: { 'retry-after': '0' } });
    const result = await handleCalmGet(makeClients(), { resource: 'task', id: 't1' });
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({ error: 'RATE_LIMITED', retryable: true, status: 429 });
  });

  it('does not wait out a long Retry-After', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: TASK })
      .reply(429, 'later', { headers: { 'retry-after': '120' } });
    const started = Date.now();
    const result = await handleCalmGet(makeClients(), { resource: 'task', id: 't1' });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(parse(result)).toMatchObject({
      error: 'RATE_LIMITED',
      hint: expect.stringContaining('120'),
    });
  });

  it('never retries a create', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: '/api/calm-documents/v1/Documents', method: 'POST' })
      .reply(503, 'busy', { headers: { 'retry-after': '0' } });
    const result = await handleCalmCreate(makeClients({ writeEnabled: true }), {
      resource: 'document',
      data: { title: 't', projectId: '11111111-1111-1111-1111-111111111111' },
    });
    // A second POST would find no interceptor and fail differently; UPSTREAM_ERROR proves one call.
    expect(parse(result)).toMatchObject({ error: 'UPSTREAM_ERROR', status: 503 });
  });

  it('stops before requesting when the call is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runWithContext({ signal: controller.signal }, () =>
      handleCalmGet(makeClients(), { resource: 'task', id: 't1' }),
    );
    expect(parse(result)).toMatchObject({ error: 'CANCELLED', retryable: false });
  });
});
