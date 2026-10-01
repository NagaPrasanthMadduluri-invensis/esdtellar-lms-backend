import MailComposer from 'nodemailer/lib/mail-composer';

import type { OutgoingMail } from './mailer.interface';

/**
 * Builds the raw MIME message, shared by the `file` and `ses` drivers.
 *
 * ## Why raw MIME rather than SES's simple Content form
 *
 * `SendEmail` accepts `{ Simple: { Subject, Body } }`, which is less code and
 * would be the obvious choice — except it has nowhere to put an arbitrary
 * header. `List-Unsubscribe` and `List-Unsubscribe-Post` are arbitrary
 * headers, and they are not decoration: Gmail and Yahoo both require
 * one-click unsubscribe from bulk senders, and a message without them is
 * more likely to be filtered and far more likely to be reported as spam
 * (because the reader's only other option IS the spam button).
 *
 * Retrofitting raw MIME later means rewriting the driver, so it is here from
 * the start.
 *
 * Sharing one composer between the two drivers is what makes the `.eml` on
 * disk a faithful preview: the bytes a reviewer opens are the bytes SES
 * would have been handed.
 */
export async function composeMime(input: {
  mail: OutgoingMail;
  from: string;
  fromName: string;
  messageId: string;
}): Promise<Buffer> {
  const { mail, from, fromName, messageId } = input;

  const composer = new MailComposer({
    from: fromName ? { name: fromName, address: from } : from,
    to: mail.toName ? { name: mail.toName, address: mail.to } : mail.to,
    // No Reply-To. Without one, a reply goes to `from`, which is the
    // no-reply address — the same outcome the empty EMAIL_REPLY_TO
    // produced, with one fewer variable. Add the field when there is a
    // mailbox worth pointing at.
    subject: mail.subject,
    // Order matters: `text` first so a client that takes the first part it
    // understands gets the plain alternative, HTML second so anything
    // capable prefers it. nodemailer emits multipart/alternative correctly
    // from these two fields.
    text: mail.text,
    html: mail.html,
    headers: mail.headers,
    messageId: `<${messageId}@spectra-lms>`,
  });

  return composer.compile().build();
}
