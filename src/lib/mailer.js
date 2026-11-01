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

function buildTransport() {
  if (env.isTest) {
    // No host, no credentials, no sockets. `info.message` carries the payload.
    return nodemailer.createTransport({ jsonTransport: true });
  }

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
    socketTimeout: 20_000,
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
export async function sendMail({ to, subject, text, html }) {
  if (!env.isTest && !env.isEmailConfigured) {
    throw new Error('Email is not configured (EMAIL_USER / EMAIL_PASS are missing)');
  }

  const message = { from: env.emailFrom, to, subject, text, html };
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