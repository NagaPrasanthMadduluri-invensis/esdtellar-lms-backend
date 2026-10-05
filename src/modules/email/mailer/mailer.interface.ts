/**
 * One interface, three drivers — the shape SCORM storage used before it
 * collapsed to one, and for the same reason: the feature must be fully
 * exercisable on a laptop with no cloud credentials.
 *
 * That is not developer convenience. The R2 variables are optional (§9.1)
 * precisely so the API starts without them, and an email system that could
 * only be tested against a live SES account would mean the first time anyone
 * saw a rendered message was in a real inbox.
 */
export interface OutgoingMail {
  to: string;
  toName?: string | null;
  subject: string;
  html: string;
  text: string;
  /**
   * Extra headers — `List-Unsubscribe` and `List-Unsubscribe-Post`. Needing
   * these is why the SES driver composes raw MIME rather than handing SES a
   * simple `{Subject, Body}`: the simple form has nowhere to put them.
   */
  headers?: Record<string, string>;
}

export interface SendResult {
  /** The provider's id, or a synthetic one for the local drivers. */
  messageId: string;
}

/**
 * Thrown by a driver when the provider refused the message.
 *
 * `retryable` is the whole point of this class. The drain loop must be able
 * to tell three cases apart, and a bare Error cannot:
 *
 *   - retryable      a network blip or a 5xx — try again later
 *   - not retryable  an unverified address — it will never succeed
 *   - throttled      not a message failure AT ALL. The row goes back to
 *                    pending WITHOUT consuming an attempt, because the
 *                    message was never wrong; we were simply going too fast.
 */
export class MailSendError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly throttled = false,
    /** Set when the provider says to stop sending entirely. */
    readonly fatalForBatch = false,
  ) {
    super(message);
    this.name = 'MailSendError';
  }
}

export abstract class Mailer {
  abstract readonly kind: 'log' | 'file' | 'ses';
  /** Why this driver cannot send, or null when it can. */
  abstract unavailableReason(): string | null;
  abstract send(mail: OutgoingMail): Promise<SendResult>;
}
