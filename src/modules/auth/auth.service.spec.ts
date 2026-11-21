import { CURRENT_PRIVACY_VERSION } from '@/common/consent';

import { consentRequiredForSession } from './auth.service';

describe('consentRequiredForSession', () => {
  it('requires consent from an account holder who never acknowledged', () => {
    expect(consentRequiredForSession(null, null)).toBe(true);
    expect(consentRequiredForSession(null, null, null)).toBe(true);
  });

  it('does not require it once the current notice is acknowledged', () => {
    expect(consentRequiredForSession(CURRENT_PRIVACY_VERSION, '2026-01-01T00:00:00Z')).toBe(false);
  });

  it('never requires it in a support session, even for an owner who never acknowledged', () => {
    expect(consentRequiredForSession(null, null, 42)).toBe(false);
    expect(consentRequiredForSession('old', '2020-01-01T00:00:00Z', 42)).toBe(false);
  });
});
