/**
 * Email bodies.
 *
 * Kept separate from the transport so the copy can change without touching
 * delivery, and so the templates can be rendered and inspected in a test.
 *
 * Every interpolation into HTML goes through `escapeHtml`. A user's display
 * name reaches this file, and "name" is free text an Admin typed -- pasting it
 * raw into a branded email is a stored-XSS-shaped hole in someone's inbox.
 */
import { env } from '../config/env.js';

function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
}

/** Outer chrome shared by both emails: dark header, white card, muted footer. */
function layout({ heading, bodyHtml, footerHtml }) {
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e5e7eb;">
            <tr>
              <td style="background:#111827;padding:20px 28px;">
                <span style="color:#ffffff;font-size:16px;font-weight:600;letter-spacing:-0.01em;">StockPulse</span>
                <span style="color:#9ca3af;font-size:12px;display:block;margin-top:2px;">Operations Console</span>
              </td>
            </tr>
            <tr>
              <td style="padding:28px;">
                <h1 style="margin:0 0 16px;font-size:18px;line-height:1.4;color:#111827;">${heading}</h1>
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:16px 28px 24px;border-top:1px solid #e5e7eb;">
                <p style="margin:0;font-size:12px;line-height:1.6;color:#6b7280;">${footerHtml}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/**
 * The reset link email.
 *
 * `resetUrl` is built by the caller from the trusted FRONTEND_URL, never from a
 * request header.
 */
export function passwordResetEmail({ name, resetUrl, ttlMinutes }) {
  const safeName = escapeHtml(name);
  const safeUrl = escapeHtml(resetUrl);
  const minutes = Number(ttlMinutes);

  const subject = 'Reset your StockPulse password';

  const text = [
    `Hi ${name},`,
    '',
    'We received a request to reset the password for your StockPulse account.',
    '',
    'Open this link to choose a new password:',
    resetUrl,
    '',
    `This link expires in ${minutes} minutes and can only be used once.`,
    '',
    'If you did not request a password reset, you can ignore this email --',
    'your password will not change unless the link above is used.',
    '',
    'StockPulse Operations Console',
  ].join('\n');

  const html = layout({
    heading: 'Reset your password',
    bodyHtml: `
      <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#374151;">Hi ${safeName},</p>
      <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#374151;">
        We received a request to reset the password for your StockPulse account.
      </p>
      <p style="margin:0 0 24px;">
        <a href="${safeUrl}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 20px;border-radius:6px;">Reset Password</a>
      </p>
      <p style="margin:0 0 8px;font-size:12px;line-height:1.6;color:#6b7280;">
        If the button does not work, paste this link into your browser:
      </p>
      <p style="margin:0 0 20px;font-size:12px;line-height:1.6;word-break:break-all;">
        <a href="${safeUrl}" style="color:#2563eb;">${safeUrl}</a>
      </p>
      <p style="margin:0;font-size:13px;line-height:1.6;color:#374151;">
        This link expires in <strong>${minutes} minutes</strong> and can only be used once.
      </p>
    `,
    footerHtml:
      'If you did not request a password reset, you can ignore this email &mdash; your password will not change unless the link above is used.',
  });

  return { subject, text, html };
}

/**
 * Sent after a successful reset.
 *
 * Deliberately contains no password, no token and no session detail: it is a
 * notification, and an email is stored in places the application does not
 * control.
 */
export function passwordChangedEmail({ name }) {
  const safeName = escapeHtml(name);
  const subject = 'Your StockPulse password was changed';

  const text = [
    `Hi ${name},`,
    '',
    'The password for your StockPulse account was just changed.',
    '',
    'You can now sign in with your new password. Any other active sessions',
    'have been signed out.',
    '',
    'If this was not you, contact your StockPulse administrator immediately.',
    '',
    'StockPulse Operations Console',
  ].join('\n');

  const html = layout({
    heading: 'Your password was changed',
    bodyHtml: `
      <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#374151;">Hi ${safeName},</p>
      <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#374151;">
        The password for your StockPulse account was just changed. You can now sign in
        with your new password.
      </p>
      <p style="margin:0;font-size:14px;line-height:1.6;color:#374151;">
        Any other active sessions have been signed out.
      </p>
    `,
    footerHtml:
      'If this was not you, contact your StockPulse administrator immediately.',
  });

  return { subject, text, html };
}

/** Absolute reset link. Built from configuration, never from a request. */
export function buildResetUrl(rawToken) {
  const base = env.FRONTEND_URL.replace(/\/+$/, '');
  return `${base}/reset-password?token=${encodeURIComponent(rawToken)}`;
}