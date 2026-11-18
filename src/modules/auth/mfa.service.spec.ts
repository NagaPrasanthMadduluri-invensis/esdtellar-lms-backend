import { MfaService, maskEmail } from './mfa.service';

const config = { get: (k: string) => ({ 'auth.mfaEncryptionKey': '', 'auth.jwtSecret': 'pepper-for-tests-0123456789abcdef' } as Record<string, string>)[k] } as any;

describe('two-step sign-in methods (0069)', () => {
  it('masks the address shown on screen', () => {
    expect(maskEmail('priya@acme.com')).toBe('p****@acme.com');
    expect(maskEmail('jo@acme.com')).toBe('j***@acme.com');
  });

  it('offers only email when the encryption key is missing, and still lets admins enrol', () => {
    const svc = new MfaService({} as any, { available: true } as any, config);
    expect(svc.isConfigured()).toBe(false);
    expect(svc.emailAvailable()).toBe(true);
    expect(svc.canEnrol()).toBe(true);
  });

  it('cannot enrol anyone when neither method can work', () => {
    const svc = new MfaService({} as any, { available: false } as any, config);
    expect(svc.canEnrol()).toBe(false);
  });

  it('emails a code, stores only a keyed hash, and accepts it once', async () => {
    let stored = '';
    let used = false;
    const repo = {
      codesIssuedSince: jest.fn().mockResolvedValue(0),
      contactFor: jest.fn().mockResolvedValue({ email: 'jo@acme.com', first_name: 'Jo', organization_id: 7, org_name: 'Acme' }),
      issueCode: jest.fn(async (_u: number, _p: string, hash: string) => { stored = hash; }),
      liveCode: jest.fn(async () => (used ? null : { id: 1, code_hash: stored })),
      markCodeUsed: jest.fn(async () => { used = true; }),
      countFailedAttempt: jest.fn(),
      findByUser: jest.fn().mockResolvedValue({ enabledAt: new Date(), method: 'email', recoveryCodes: [] }),
    } as any;
    let sent = '';
    const mail = { available: true, sendSignInCode: jest.fn(async (i: { code: string }) => { sent = i.code; }) } as any;
    const svc = new MfaService(repo, mail, config);

    expect(await svc.startLoginChallenge(5)).toBe('j***@acme.com');
    expect(sent).toMatch(/^\d{6}$/);
    expect(stored).not.toContain(sent);
    expect(await svc.verifyCode(5, sent === '000000' ? '111111' : '000000')).toBe(false);
    expect(await svc.verifyCode(5, sent)).toBe(true);
    expect(await svc.verifyCode(5, sent)).toBe(false);
  });

  it('refuses a sixth code within the window', async () => {
    const repo = { codesIssuedSince: jest.fn().mockResolvedValue(5) } as any;
    const svc = new MfaService(repo, { available: true } as any, config);
    await expect(svc.startLoginChallenge(5)).rejects.toMatchObject({ status: 429 });
  });
});
