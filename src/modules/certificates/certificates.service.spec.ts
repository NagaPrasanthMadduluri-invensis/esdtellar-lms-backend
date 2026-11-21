import { isVirtualSessionType } from './certificates.service';

describe('isVirtualSessionType', () => {
  it('treats Virtual and Webinar as online sittings', () => {
    expect(isVirtualSessionType('Virtual')).toBe(true);
    expect(isVirtualSessionType('Webinar')).toBe(true);
  });

  it('treats ILT and missing types as in person', () => {
    expect(isVirtualSessionType('ILT')).toBe(false);
    expect(isVirtualSessionType(null)).toBe(false);
    expect(isVirtualSessionType(undefined)).toBe(false);
  });
});
