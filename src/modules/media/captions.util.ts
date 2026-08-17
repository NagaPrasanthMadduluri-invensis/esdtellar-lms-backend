/**
 * Caption normalisation.
 *
 * The learner UI renders captions with a `<track>` element, and browsers accept
 * exactly one format there: WebVTT. SRT is what most people actually have, and
 * the two differ only in a header line and the decimal separator in cue
 * timings — so rather than reject an SRT upload, it is converted on the way in
 * and stored as `.vtt`. What is in R2 is always ready to serve.
 */

const SRT_TIMESTAMP = /(\d{2}:\d{2}:\d{2}),(\d{1,3})/g;

/** Strips a UTF-8 BOM and normalises line endings to LF. */
function normalise(text: string): string {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/**
 * Returns WebVTT for either a `.vtt` or `.srt` input.
 * Throws when the content does not look like either.
 */
export function toWebVtt(raw: string): string {
  const text = normalise(raw).trim();

  if (!text) {
    throw new Error('Caption file is empty.');
  }

  // Already WebVTT — pass through untouched apart from normalisation.
  if (text.startsWith('WEBVTT')) {
    return `${text}\n`;
  }

  // An SRT cue block is `index \n start --> end \n text`. The arrow is the one
  // token both formats must contain, so its absence means this is not a
  // subtitle file at all.
  if (!text.includes('-->')) {
    throw new Error(
      'Caption file is not valid WebVTT or SRT (no cue timings found).',
    );
  }

  return `WEBVTT\n\n${text.replace(SRT_TIMESTAMP, '$1.$2')}\n`;
}
