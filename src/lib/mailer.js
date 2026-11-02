/**
 * Transactional email.
 *
 * One module-level transporter for the whole process. Building a transport per
 * message would open a fresh TLS handshake to Gmail for every reset request,
 * which is both slow and the fastest way to get the account rate-limited.
 *
 * Test behaviour is deliberately different: Nodemailer's `jsonTransport`
 * serialises the message instead of contacting a network, and each message is
 * also appended to `outbox` so the suite can assert on what would have been
 * sent. A test that requires a real mailbox is a test that fails offline.
 *
 * Transport selection (evaluated lazily at first send, not at import time):
 *   1. NODE_ENV=test       → jsonTransport  (no network; messages go to outbox)
 *   2. RESEND_API_KEY set  → Resend SMTP    (smtp.resend.com:465, user="resend")
 *   3. Fallback            → SMTP configured by SMTP_HOST / EMAIL_USER / EMAIL_PASS
 */
import nodemailer from 'nodemailer';

import { env } from '../config/env.js';
import { logger } from './logger.js';

/**
 * Messages produced in the test environment, oldest first.
 *
 * Only populated when `env.isTest`; in any other environment this stays empty,
 * so it can never become an accidental message archive in production.
 */
export const outbox = [];

let transporter = null;

// ---------------------------------------------------------------------------
// LEGACY / INCOMPLETE DRAFT (kept as a comment, not executed)
// ---------------------------------------------------------------------------
// An earlier integration attempt used a community package `nodemailer-resend`
// that turned out not to exist on npm. The `Resend` class shown below is the
// pattern from that draft. The active integration below uses Resend's official
// SMTP bridge instead (smtp.resend.com), which works with plain nodemailer.
//
// import { Resend } from 'nodemailer-resend';   // ← package does not exist
// const transporter1 = nodemailer.createTransport(
//   Resend({ apiKey: process.env.RESEND_API_KEY })
// );
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// RESEND + NODEMAILER INTEGRATION (via Resend's official SMTP bridge)
//
// Resend provides a standard SMTP endpoint so any Nodemailer-based app can
// use it without a custom transport package:
//
//   host: smtp.resend.com
//   port: 465  (SSL)
//   auth.user: "resend"           ← literal string, not your email
//   auth.pass: RESEND_API_KEY
//
// See: https://resend.com/docs/send-with-nodemailer
// ---------------------------------------------------------------------------

function buildTransport() {
  if (env.isTest) {
    // No host, no credentials, no sockets. `info.message` carries the payload.
    return nodemailer.createTransport({ jsonTransport: true });
  }

  // Prefer Resend when an API key is present.
  if (process.env.RESEND_API_KEY) {
    logger.info('mailer: using Resend SMTP transport (smtp.resend.com)');
    return nodemailer.createTransport({
      host: 'smtp.resend.com',
      port: 465,
      secure: true,
      auth: {
        user: 'resend',                         // required literal value by Resend
        pass: process.env.RESEND_API_KEY,
      },
    });
  }

  // Fallback: traditional SMTP (Gmail App Password, SendGrid SMTP, etc.)
  logger.info('mailer: using SMTP transport', { host: env.SMTP_HOST, port: env.SMTP_PORT });
  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: {
      user: env.EMAIL_USER,
      pass: env.EMAIL_PASS,
    },
    // Gmail is slow to accept a connection under load; without these a stuck
    // SMTP handshake would hold a request open indefinitely.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 40_000,
  });
}

function getTransport() {
  if (!transporter) transporter = buildTransport();
  return transporter;
}

/**
 * Sends one message.
 *
 * Throws on failure so the caller can decide what to do. Callers on the public
 * reset path must NOT surface the reason to the client: the response is generic
 * by design, and an SMTP error message would distinguish "mailbox broken" from
 * "no such account".
 */
export async function sendMail({ to, subject, text, html, from }) {
  if (!env.isTest && !env.isEmailConfigured && !process.env.RESEND_API_KEY) {
    throw new Error('Email is not configured (EMAIL_USER / EMAIL_PASS or RESEND_API_KEY are missing)');
  }

  const message = { from: from ?? env.emailFrom, to, subject, text, html };
  const info = await getTransport().sendMail(message);

  if (env.isTest) {
    outbox.push({ ...message, message: info.message });
  }

  // Subject and recipient only. Never the body: it contains the reset URL.
  logger.info('email dispatched', { to, subject });
  return info;
}

/** Empties the test outbox. No effect outside the test environment. */
export function resetOutbox() {
  outbox.length = 0;
}

/**
 * Sends without blocking, and without ever rejecting.
 *
 * Used on the password-reset request path. Awaiting the SMTP round-trip there
 * would make a request for a real account measurably slower (hundreds of
 * milliseconds) than one for an unknown address -- which is exactly the timing
 * signal that defeats a generic response.
 */
export function sendMailInBackground(message) {
  sendMail(message).catch((error) => {
    // Safe operational detail only: no recipient body, no token.
    logger.error('email dispatch failed', { subject: message.subject, error: error.message });
  });
}
<<<<<<< HEAD

// ---------------------------------------------------------------------------
// CONVENIENCE: Password Reset Email (Resend / SMTP – whichever transport is active)
//
// `sendResetEmail` is a thin wrapper around the generic `sendMail` helper so
// the caller (auth service) stays decoupled from transport details.
//
// `from` is pinned to the Resend onboarding domain while you are testing with
// a free Resend account. Once your own domain is verified in the Resend
// dashboard you can replace it with env.emailFrom (which reads EMAIL_FROM).
//
// Usage:
//   import { sendResetEmail } from '../lib/mailer.js';
//   await sendResetEmail(user.email, resetToken);
// ---------------------------------------------------------------------------

/**
 * Sends a password-reset link to the given address.
 *
 * @param {string} toEmail  – recipient email address
 * @param {string} token    – signed reset token (never logged or returned to caller)
 */
export async function sendResetEmail(toEmail, token) {
  const resetUrl = `${process.env.FRONTEND_URL ?? env.FRONTEND_URL}/reset-password?token=${token}`;

  // The `from` address used here matches Resend's test sender so the email
  // arrives during development without domain verification. Switch to
  // env.emailFrom once your domain is verified in Resend.
  const from = process.env.RESEND_API_KEY
    ? 'StockPulse <onboarding@resend.dev>'
    : env.emailFrom;

  await sendMail({
    to: toEmail,
    from, // overrides the default env.emailFrom when using Resend test sender
    subject: 'Reset your StockPulse password',
    html: `
      <p>Hello,</p>
      <p>We received a request to reset the password for your StockPulse account.</p>
      <p>
        <a href="${resetUrl}" style="display:inline-block;padding:10px 20px;background:#0ea5e9;color:#fff;border-radius:6px;text-decoration:none;">
          Reset password
        </a>
      </p>
      <p>This link expires in ${env.RESET_TOKEN_TTL_MINUTES ?? 30} minutes.</p>
      <p>If you did not request a password reset you can safely ignore this email.</p>
    `,
    text: `Reset your StockPulse password: ${resetUrl}\n\nThis link expires in ${env.RESET_TOKEN_TTL_MINUTES ?? 30} minutes.`,
  });
}
=======
>>>>>>> 2708c803ef4a10f0ba1dce0faf980afd2b379698
