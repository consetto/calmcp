// The Documents API strips `<img>` from returned bodies; calmcp checks the stored body with a
// `contains(content,'<img')` filter and flags the documents whose images were left out.

import { MockAgent, setGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleCalmGet } from '../../src/tools/calmGet.js';
import { handleCalmList } from '../../src/tools/calmList.js';
import { makeClients, ORIGIN, parse } from './helpers.js';

const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const DOCS = '/api/calm-documents/v1/Documents';

/** Matches the image check, which filters on the stored body. */
const isImageCheck = (path: string) =>
  path.startsWith(`${DOCS}?`) && decodeURIComponent(path).includes("contains(content,'<img')");

/** Matches the list request itself, with or without a query string. */
const isListRequest = (path: string) =>
  (path === DOCS || path.startsWith(`${DOCS}?`)) && !isImageCheck(path);

describe('documents whose images the API leaves out', () => {
  let agent: MockAgent;
  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    await agent.close();
  });

  it('flags a document whose stored body has images', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: `${DOCS}/${A}` })
      .reply(200, { uuid: A, title: 't', content: '<p>Step 1</p><p><span></span></p>' });
    agent
      .get(ORIGIN)
      .intercept({ path: isImageCheck })
      .reply(200, { value: [{ uuid: A }] });

    const body = parse(await handleCalmGet(makeClients(), { resource: 'document', id: A }));
    expect(body).toMatchObject({ uuid: A, imagesOmitted: true });
    expect((body as { imagesNote: string }).imagesNote).toContain('does not return');
  });

  it('leaves a document without images alone', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: `${DOCS}/${A}` })
      .reply(200, { uuid: A, content: '<p>text</p>' });
    agent.get(ORIGIN).intercept({ path: isImageCheck }).reply(200, { value: [] });

    const body = parse(await handleCalmGet(makeClients(), { resource: 'document', id: A }));
    expect(body).not.toHaveProperty('imagesOmitted');
    expect(body).not.toHaveProperty('imagesNote');
  });

  it('does not check a body that still carries its images', async () => {
    // No intercept for the check: with net connect disabled, a check request would fail the call.
    agent
      .get(ORIGIN)
      .intercept({ path: `${DOCS}/${A}` })
      .reply(200, { uuid: A, content: '<img src="/ui/imageServiceAPI/v1/getImage?imageId=x">' });

    const result = await handleCalmGet(makeClients(), { resource: 'document', id: A });
    expect(result.isError).toBeFalsy();
    expect(parse(result)).not.toHaveProperty('imagesOmitted');
  });

  it('says so when the check fails, rather than implying there are no images', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: `${DOCS}/${A}` })
      .reply(200, { uuid: A, content: '<p>x</p>' });
    agent.get(ORIGIN).intercept({ path: isImageCheck }).reply(500, 'boom');

    const result = await handleCalmGet(makeClients(), { resource: 'document', id: A });
    expect(result.isError).toBeFalsy();
    const body = parse(result) as { imagesNote?: string };
    expect(body).not.toHaveProperty('imagesOmitted');
    expect(body.imagesNote).toContain('could not check');
  });

  it('flags the right records of a projected list in one check', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: isListRequest })
      .reply(200, {
        value: [
          { uuid: A, displayId: '7-1', content: '<p>a</p>' },
          { uuid: B, displayId: '7-2', content: '<p>b</p>' },
        ],
      });
    agent
      .get(ORIGIN)
      .intercept({ path: isImageCheck })
      .reply(200, { value: [{ uuid: B }] });

    const body = parse(
      await handleCalmList(makeClients(), {
        resource: 'documents',
        fields: 'displayId,content',
      }),
    ) as { value: Record<string, unknown>[] };
    expect(body.value[0]).not.toHaveProperty('imagesOmitted');
    expect(body.value[1]).toMatchObject({ displayId: '7-2', imagesOmitted: true });
  });

  it('skips the check when fields leaves content out', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: isListRequest })
      .reply(200, { value: [{ uuid: A, displayId: '7-1', content: '<p>a</p>' }] });

    const result = await handleCalmList(makeClients(), {
      resource: 'documents',
      fields: 'displayId',
    });
    expect(result.isError).toBeFalsy();
    expect((parse(result) as { value: unknown[] }).value[0]).toEqual({ displayId: '7-1' });
  });

  it('checks a long list in batches of at most 50 documents', async () => {
    const uuids = Array.from(
      { length: 120 },
      (_, i) => `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`,
    );
    agent
      .get(ORIGIN)
      .intercept({ path: isListRequest })
      .reply(200, { value: uuids.map((uuid) => ({ uuid, content: '<p>x</p>' })) });
    // undici may call the matcher more than once per request, and encodes spaces as "+": count
    // each distinct decoded query once.
    const checks = new Set<string>();
    agent
      .get(ORIGIN)
      .intercept({
        path: (path) => {
          if (!isImageCheck(path)) return false;
          checks.add(decodeURIComponent(path.replace(/\+/g, ' ')));
          return true;
        },
      })
      .reply(200, { value: [{ uuid: uuids[119] }] })
      .times(3);

    const body = parse(await handleCalmList(makeClients(), { resource: 'documents' })) as {
      value: Record<string, unknown>[];
    };
    const batchSizes = [...checks].map((query) => (query.match(/uuid eq /g) ?? []).length);
    expect(batchSizes.sort((a, b) => a - b)).toEqual([20, 50, 50]);
    expect(body.value[119]).toMatchObject({ imagesOmitted: true });
    expect(body.value[0]).not.toHaveProperty('imagesOmitted');
  });

  it('does not check an empty body', async () => {
    agent
      .get(ORIGIN)
      .intercept({ path: `${DOCS}/${A}` })
      .reply(200, { uuid: A, content: '' });
    const result = await handleCalmGet(makeClients(), { resource: 'document', id: A });
    expect(result.isError).toBeFalsy();
    expect(parse(result)).not.toHaveProperty('imagesNote');
  });
});
