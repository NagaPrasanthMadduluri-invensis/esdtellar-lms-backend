import { AlertsService } from './alerts.service';
import { WorkerWatchService } from './watchdog.service';

const config = (values: Record<string, unknown>) => ({ get: (k: string) => values[k] }) as any;
const on = config({
  'alerts.cliqUrl': 'https://cliq.example/api/message',
  'alerts.cliqToken': 'tok',
  'alerts.cliqBot': 'bot',
  clientOrigin: 'https://spectralms.example.com',
});
const flush = () => new Promise((r) => setImmediate(r));

describe('AlertsService', () => {
  let fetchMock: jest.Mock;
  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 204, text: async () => '' });
    (global as any).fetch = fetchMock;
  });

  it('posts as the bot, labelled with the environment, and never sends emails or IPs', async () => {
    new AlertsService(on).send({
      key: 'k', level: 'high', title: 'Test for jo@acme.com',
      lines: ['from 203.0.113.9 and 2406:7400:94:b4d7:e38c:1595:ce48:86dc'],
    });
    await flush();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('zapikey=tok');
    expect(url).toContain('bot_unique_name=bot');
    const text = JSON.parse(init.body).text as string;
    expect(text).toContain('🟠 HIGH');
    expect(text).toContain('spectralms.example.com');
    expect(text).not.toContain('jo@acme.com');
    expect(text).not.toContain('203.0.113.9');
    expect(text).not.toContain('2406:7400');
  });

  it('sends the same key once per repeat window', async () => {
    const a = new AlertsService(on);
    a.send({ key: 'same', level: 'info', title: 'x' });
    a.send({ key: 'same', level: 'info', title: 'x' });
    a.send({ key: 'other', level: 'info', title: 'y' });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries as the token owner when the bot is not in the channel', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => '{"code":"bot_not_member"}' })
      .mockResolvedValueOnce({ ok: true, status: 204, text: async () => '' });
    new AlertsService(on).send({ key: 'b', level: 'info', title: 'x' });
    await flush(); await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).not.toContain('bot_unique_name');
  });

  it('sends nothing when no token is configured', async () => {
    new AlertsService(config({})).send({ key: 'k', level: 'info', title: 'x' });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('alerts on the 10th failed sign-in for one account, by user number only', async () => {
    const a = new AlertsService(on);
    for (let i = 0; i < 9; i++) a.recordFailedLogin(42, 7);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    a.recordFailedLogin(42, 7);
    await flush();
    const text = JSON.parse(fetchMock.mock.calls[0][1].body).text as string;
    expect(text).toContain('user #42');
  });

  it('alerts on the 5th unexpected server error within 5 minutes', async () => {
    const a = new AlertsService(on);
    for (let i = 0; i < 4; i++) a.recordServerError('GET /x', 'TypeError');
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    a.recordServerError('GET /x', 'TypeError');
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ignores rate limits that are not about signing in', async () => {
    const a = new AlertsService(on);
    a.recordRateLimit('certificate-verify', 'GET /x');
    a.recordRateLimit('default-user', 'GET /x');
    a.recordRateLimit('login-account', 'POST /api/auth/login');
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('WorkerWatchService', () => {
  it('alerts after two failed health checks, once, and again on recovery', async () => {
    const sent: string[] = [];
    const alerts = { send: (a: { key: string }) => sent.push(a.key) } as any;
    const repo = { beat: jest.fn().mockResolvedValue(undefined) } as any;
    const watch = new WorkerWatchService(repo, alerts, config({ port: 1 }));
    const down = jest.fn().mockRejectedValue(new Error('refused'));
    (global as any).fetch = down;
    await watch.minute();
    expect(sent).toEqual([]);
    await watch.minute();
    await watch.minute();
    expect(sent).toEqual(['api-down']);
    (global as any).fetch = jest.fn().mockResolvedValue({ ok: true });
    await watch.minute();
    expect(sent[1]).toMatch(/^api-recovered/);
    expect(repo.beat).toHaveBeenCalledTimes(4);
  });
});
