import { AiClientService } from './ai-client.service';
import { AiInsightsService } from './ai-insights.service';

const enabledAi = {
  enabled: true,
  apiKey: 'sk-test',
  model: 'deepseek/deepseek-v4-pro',
  baseUrl: 'https://openrouter.ai/api/v1',
  timeoutMs: 30000,
  maxOutputTokens: 1500,
  appTitle: 'Spectra LMS',
};
const disabledAi = { ...enabledAi, enabled: false };
const noKeyAi = { ...enabledAi, apiKey: '' };

function makeConfig(ai: Record<string, unknown>) {
  return {
    getOrThrow: (key: string) => (key === 'ai' ? ai : undefined),
    get: (key: string) =>
      key === 'clientOrigin' ? 'http://localhost:3000' : undefined,
  } as any;
}

describe('AiClientService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('is enabled only when switched on AND a key is present', () => {
    expect(new AiClientService(makeConfig(disabledAi)).isEnabled()).toBe(false);
    expect(new AiClientService(makeConfig(noKeyAi)).isEnabled()).toBe(false);
    expect(new AiClientService(makeConfig(enabledAi)).isEnabled()).toBe(true);
  });

  it('makes no external call and returns null when disabled', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch' as never);
    const svc = new AiClientService(makeConfig(disabledAi));
    await expect(svc.complete({ system: 's', user: 'u' })).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('posts to OpenRouter with auth + model and returns the content', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch' as never).mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'hello' } }] }),
    } as never);
    const svc = new AiClientService(makeConfig(enabledAi));

    await expect(svc.complete({ system: 's', user: 'u' })).resolves.toBe('hello');

    const [url, init] = (fetchSpy.mock.calls[0] as unknown) as [string, any];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('deepseek/deepseek-v4-pro');
    expect(body.messages).toHaveLength(2);
  });

  it('returns null on a non-ok response (never throws)', async () => {
    jest.spyOn(global, 'fetch' as never).mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'rate limited',
    } as never);
    const svc = new AiClientService(makeConfig(enabledAi));
    await expect(svc.complete({ system: 's', user: 'u' })).resolves.toBeNull();
  });

  it('completeJson recovers JSON wrapped in prose / a code fence', async () => {
    jest.spyOn(global, 'fetch' as never).mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Sure!\n```json\n{"a":1}\n```' } }],
      }),
    } as never);
    const svc = new AiClientService(makeConfig(enabledAi));
    await expect(svc.completeJson({ system: 's', user: 'u' })).resolves.toEqual({
      a: 1,
    });
  });

  it('requests a json_schema response_format when a schema is given', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch' as never).mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{}' } }] }),
    } as never);
    const svc = new AiClientService(makeConfig(enabledAi));

    await svc.complete({
      system: 's',
      user: 'u',
      jsonSchema: { name: 'rec', schema: { type: 'object' } },
    });

    const body = JSON.parse(((fetchSpy.mock.calls[0] as unknown) as [string, any])[1].body);
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.name).toBe('rec');
  });
});

describe('AiInsightsService', () => {
  const scope = { organizationId: 7, platformOrganizationId: 1 } as any;

  it('stamps the configured model when storing an insight', async () => {
    const client = { model: 'deepseek/deepseek-v4-pro' } as any;
    const repo = { upsert: jest.fn().mockResolvedValue(undefined) } as any;
    const svc = new AiInsightsService(client, repo);

    await svc.storeInsight(scope, 'learner', 42, 'recommendations', { tips: [] });

    expect(repo.upsert).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        subjectType: 'learner',
        subjectId: 42,
        kind: 'recommendations',
        model: 'deepseek/deepseek-v4-pro',
      }),
    );
  });
});
