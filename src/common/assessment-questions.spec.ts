import {
  isAnswerCorrect,
  normaliseAnswer,
  parseMatchingPairs,
} from './assessment-questions';

const q = (type: string, extra: Partial<{ correct_answer: string | null; correct_option_ids: number[] }> = {}) => ({
  question_type: type,
  correct_answer: null,
  correct_option_ids: [],
  ...extra,
});

describe('normaliseAnswer', () => {
  it('ignores case and collapses whitespace', () => {
    expect(normaliseAnswer('  New   York ')).toBe('new york');
    expect(normaliseAnswer(undefined)).toBe('');
  });
});

describe('parseMatchingPairs', () => {
  it('reads the editor format, one `left = right` per line', () => {
    expect(parseMatchingPairs('France = Paris\nItaly = Rome\n\n')).toEqual([
      { left: 'France', right: 'Paris' },
      { left: 'Italy', right: 'Rome' },
    ]);
  });
  it('accepts ; separators and JSON pairs, skips malformed entries', () => {
    expect(parseMatchingPairs('A=1;B=2;junk')).toEqual([
      { left: 'A', right: '1' },
      { left: 'B', right: '2' },
    ]);
    expect(parseMatchingPairs('[{"left":"A","right":"1"},{"left":"B"}]')).toEqual([
      { left: 'A', right: '1' },
    ]);
    expect(parseMatchingPairs(null)).toEqual([]);
  });
});

describe('isAnswerCorrect', () => {
  it('mcq: the one correct option', () => {
    const mcq = q('mcq', { correct_option_ids: [5] });
    expect(isAnswerCorrect(mcq, { selected_option_ids: [5] })).toBe(true);
    expect(isAnswerCorrect(mcq, { selected_option_ids: [6] })).toBe(false);
    expect(isAnswerCorrect(mcq, { selected_option_ids: [] })).toBe(false);
  });

  it('multiselect: exactly the set of correct options', () => {
    const ms = q('multiselect', { correct_option_ids: [1, 2] });
    expect(isAnswerCorrect(ms, { selected_option_ids: [2, 1] })).toBe(true);
    expect(isAnswerCorrect(ms, { selected_option_ids: [2] })).toBe(false);
    expect(isAnswerCorrect(ms, { selected_option_ids: [1, 2, 3] })).toBe(false);
  });

  it('fillblank: case- and whitespace-insensitive', () => {
    const fb = q('fillblank', { correct_answer: 'New York' });
    expect(isAnswerCorrect(fb, { selected_option_ids: [], answer: ' new  york' })).toBe(true);
    expect(isAnswerCorrect(fb, { selected_option_ids: [], answer: 'Boston' })).toBe(false);
    expect(isAnswerCorrect(fb, { selected_option_ids: [] })).toBe(false);
    expect(isAnswerCorrect(q('fillblank'), { selected_option_ids: [], answer: '' })).toBe(false);
  });

  it('matching: every pair right and nothing extra', () => {
    const m = q('matching', { correct_answer: 'A=1;B=2' });
    expect(isAnswerCorrect(m, { selected_option_ids: [], pairs: [{ left: 'b', right: '2' }, { left: 'A', right: '1' }] })).toBe(true);
    expect(isAnswerCorrect(m, { selected_option_ids: [], pairs: [{ left: 'A', right: '1' }] })).toBe(false);
    expect(isAnswerCorrect(m, { selected_option_ids: [], pairs: [{ left: 'A', right: '2' }, { left: 'B', right: '1' }] })).toBe(false);
    expect(isAnswerCorrect(m, { selected_option_ids: [], pairs: [{ left: 'A', right: '1' }, { left: 'A', right: '1' }] })).toBe(false);
  });
});
