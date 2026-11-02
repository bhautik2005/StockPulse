/**
 * Transactional email.
 *
 * Transport selection (evaluated at send time):
 *   1. NODE_ENV=test       → json mock (no network; records to outbox)
 *   2. RESEND_API_KEY set  → Resend HTTPS REST API (https://api.resend.com/emails over Port 443)
 *                            Bypasses all cloud firewall / SMTP port blocks on Render, Vercel, AWS.
 *   3. Fallback            → Nodemailer SMTP configured by SMTP_HOST / EMAIL_USER / EMAIL_PASS
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
// RESEND HTTPS REST API (Port 443)
//
// Cloud providers (Render, AWS, DigitalOcean) frequently block outbound SMTP
// ports (25, 465, 587). The Resend REST API sends over standard HTTPS (port 443)
// which is never blocked by cloud firewalls.
// ---------------------------------------------------------------------------
async function sendViaResendHttp({ to, from, subject, text, html }) {
  logger.info('mailer: dispatching via Resend HTTPS API (Port 443)');

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: Array.isArray(to) ? to : [to],
      subject,
      ...(text ? { text } : {}),
      ...(html ? { html } : {}),
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    const errorMsg = data?.message || data?.error || response.statusText || 'Resend API request failed';
    throw new Error(`Resend API Error (${response.status}): ${errorMsg}`);
  }

  return { messageId: data.id, ...data };
}

// ---------------------------------------------------------------------------
// FALLBACK: Nodemailer SMTP
// ---------------------------------------------------------------------------
function buildTransport() {
  if (env.isTest) {
    // No host, no credentials, no sockets. `info.message` carries the payload.
    return nodemailer.createTransport({ jsonTransport: true });
  }

  // Traditional SMTP fallback (Gmail App Password, custom SMTP, etc.)
  logger.info('mailer: using SMTP transport', { host: env.SMTP_HOST, port: env.SMTP_PORT });
  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: {
      user: env.EMAIL_USER,
      pass: env.EMAIL_PASS,
    },
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
 * Uses Resend HTTPS API (port 443) when RESEND_API_KEY is present,
 * or falls back to Nodemailer SMTP.
 */
export async function sendMail({ to, subject, text, html, from }) {
  if (!env.isTest && !env.isEmailConfigured && !process.env.RESEND_API_KEY) {
    throw new Error('Email is not configured (EMAIL_USER / EMAIL_PASS or RESEND_API_KEY are missing)');
  }

  // When using Resend, domains like @gmail.com cannot be verified and are rejected with 403.
  // Unless a verified custom EMAIL_FROM is configured, use Resend's test sender (onboarding@resend.dev).
  let sender = from;
  if (!sender) {
    if (process.env.RESEND_API_KEY && (!env.EMAIL_FROM || env.emailFrom.includes('@gmail.com'))) {
      sender = 'StockPulse <onboarding@resend.dev>';
    } else {
      sender = env.emailFrom;
    }
  } else if (process.env.RESEND_API_KEY && sender.includes('@gmail.com')) {
    sender = 'StockPulse <onboarding@resend.dev>';
  }

  const message = { from: sender, to, subject, text, html };

  let info;

  if (env.isTest) {
    info = await getTransport().sendMail(message);
    outbox.push({ ...message, message: info.message });
  } else if (process.env.RESEND_API_KEY) {
    // Primary production route: HTTPS API (Port 443) - zero connection timeouts
    info = await sendViaResendHttp({ to, from: sender, subject, text, html });
  } else {
    // Fallback: SMTP route
    info = await getTransport().sendMail(message);
  }

  // Subject and recipient only. Never the body: it contains the reset URL.
  logger.info('email dispatched', { to, subject, messageId: info.messageId });
  return info;
}

/** Empties the test outbox. No effect outside the test environment. */
export function resetOutbox() {
  outbox.length = 0;
}

/**
 * Sends without blocking, and without ever rejecting.
 *
 * Used on the password-reset request path. Awaiting the network round-trip there
 * would make a request for a real account measurably slower than one for an unknown
 * address -- which is exactly the timing signal that defeats a generic response.
 */
export function sendMailInBackground(message) {
  sendMail(message).catch((error) => {
    // Safe operational detail only: no recipient body, no token.
    logger.error('email dispatch failed', { subject: message.subject, error: error.message });
  });
}

// ---------------------------------------------------------------------------
// CONVENIENCE: Password Reset Email (Resend HTTPS / SMTP)
//
// `from` is pinned to the Resend onboarding domain while testing with a free
// Resend account. Once your custom domain is verified in the Resend dashboard,
// you can replace it with your own verified domain.
// ---------------------------------------------------------------------------

/**
 * Sends a password-reset link to the given address.
 *
 * @param {string} toEmail  – recipient email address
 * @param {string} token    – signed reset token (never logged or returned to caller)
 */
export async function sendResetEmail(toEmail, token) {
  const resetUrl = `${process.env.FRONTEND_URL ?? env.FRONTEND_URL}/reset-password?token=${token}`;

  const from = process.env.RESEND_API_KEY
    ? 'StockPulse <EMAIL_USER>'
    : env.emailFrom;

  await sendMail({
    to: toEmail,
    from,
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
