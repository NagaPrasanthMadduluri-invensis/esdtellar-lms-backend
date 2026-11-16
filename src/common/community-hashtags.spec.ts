import { collectHashtags, extractInlineHashtags, normalizeHashtag } from './community-hashtags';
import { COMMUNITY_HASHTAG_MAX, COMMUNITY_HASHTAGS_PER_POST_MAX } from './content-limits';

describe('normalizeHashtag', () => {
  it('collapses #, case and whitespace to one stored tag, keeping first casing as label', () => {
    expect(normalizeHashtag('#Renewables')).toEqual({ tag: 'renewables', label: 'Renewables' });
    expect(normalizeHashtag('  renewables ')).toEqual({ tag: 'renewables', label: 'renewables' });
  });

  it('strips characters that are not letters, digits or underscore', () => {
    expect(normalizeHashtag('foo-bar!')).toEqual({ tag: 'foobar', label: 'foobar' });
  });

  it('returns null for empty / non-string / bare #', () => {
    expect(normalizeHashtag('')).toBeNull();
    expect(normalizeHashtag('#')).toBeNull();
    expect(normalizeHashtag(42 as unknown)).toBeNull();
    expect(normalizeHashtag(null)).toBeNull();
  });

  it('caps the length at COMMUNITY_HASHTAG_MAX', () => {
    const long = 'a'.repeat(COMMUNITY_HASHTAG_MAX + 20);
    expect(normalizeHashtag(long)!.tag).toHaveLength(COMMUNITY_HASHTAG_MAX);
  });
});

describe('extractInlineHashtags', () => {
  it('pulls #tokens out of free text', () => {
    expect(extractInlineHashtags('loving #Solar and #wind_power today')).toEqual(['#Solar', '#wind_power']);
    expect(extractInlineHashtags(undefined)).toEqual([]);
  });
});

describe('collectHashtags', () => {
  it('de-duplicates by normalised tag with first label winning', () => {
    expect(collectHashtags(['#Solar', 'solar', ' SOLAR '])).toEqual([{ tag: 'solar', label: 'Solar' }]);
  });

  it('caps the number of tags per post', () => {
    const many = Array.from({ length: COMMUNITY_HASHTAGS_PER_POST_MAX + 5 }, (_, i) => `tag${i}`);
    expect(collectHashtags(many)).toHaveLength(COMMUNITY_HASHTAGS_PER_POST_MAX);
  });

  it('ignores empties and handles a nullish list', () => {
    expect(collectHashtags(['', '#', 'ok'])).toEqual([{ tag: 'ok', label: 'ok' }]);
    expect(collectHashtags(undefined as unknown as unknown[])).toEqual([]);
  });
});
