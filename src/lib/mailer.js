// /**
//  * Transactional email.
//  *
//  * Transport selection (evaluated at send time):
//  *   1. NODE_ENV=test       → json mock (no network; records to outbox)
//  *   2. RESEND_API_KEY set  → Resend HTTPS REST API (https://api.resend.com/emails over Port 443)
//  *                            Bypasses all cloud firewall / SMTP port blocks on Render, Vercel, AWS.
//  *   3. Fallback            → Nodemailer SMTP configured by SMTP_HOST / EMAIL_USER / EMAIL_PASS
//  */
// import nodemailer from 'nodemailer';

// import { env } from '../config/env.js';
// import { logger } from './logger.js';

// /**
//  * Messages produced in the test environment, oldest first.
//  *
//  * Only populated when `env.isTest`; in any other environment this stays empty,
//  * so it can never become an accidental message archive in production.
//  */
// export const outbox = [];

// let transporter = null;

// // ---------------------------------------------------------------------------
// // RESEND HTTPS REST API (Port 443)
// //
// // Cloud providers (Render, AWS, DigitalOcean) frequently block outbound SMTP
// // ports (25, 465, 587). The Resend REST API sends over standard HTTPS (port 443)
// // which is never blocked by cloud firewalls.
// // ---------------------------------------------------------------------------
// async function sendViaResendHttp({ to, from, subject, text, html }) {
//   logger.info('mailer: dispatching via Resend HTTPS API (Port 443)');

//   const response = await fetch('https://api.resend.com/emails', {
//     method: 'POST',
//     headers: {
//       Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
//       'Content-Type': 'application/json',
//     },
//     body: JSON.stringify({
//       from,
//       to: Array.isArray(to) ? to : [to],
//       subject,
//       ...(text ? { text } : {}),
//       ...(html ? { html } : {}),
//     }),
//   });

//   const data = await response.json();

//   if (!response.ok) {
//     const errorMsg = data?.message || data?.error || response.statusText || 'Resend API request failed';
//     throw new Error(`Resend API Error (${response.status}): ${errorMsg}`);
//   }

//   return { messageId: data.id, ...data };
// }

// // ---------------------------------------------------------------------------
// // FALLBACK: Nodemailer SMTP
// // ---------------------------------------------------------------------------
// function buildTransport() {
//   if (env.isTest) {
//     // No host, no credentials, no sockets. `info.message` carries the payload.
//     return nodemailer.createTransport({ jsonTransport: true });
//   }

//   // Traditional SMTP fallback (Gmail App Password, custom SMTP, etc.)
//   logger.info('mailer: using SMTP transport', { host: env.SMTP_HOST, port: env.SMTP_PORT });
//   return nodemailer.createTransport({
//     host: env.SMTP_HOST,
//     port: env.SMTP_PORT,
//     secure: env.SMTP_SECURE,
//     auth: {
//       user: env.EMAIL_USER,
//       pass: env.EMAIL_PASS,
//     },
//     connectionTimeout: 10_000,
//     greetingTimeout: 10_000,
//     socketTimeout: 20_000,
//   });
// }

// function getTransport() {
//   if (!transporter) transporter = buildTransport();
//   return transporter;
// }

// /**
//  * Sends one message.
//  *
//  * Uses Resend HTTPS API (port 443) when RESEND_API_KEY is present,
//  * or falls back to Nodemailer SMTP.
//  */
// export async function sendMail({ to, subject, text, html, from }) {
//   if (!env.isTest && !env.isEmailConfigured && !process.env.RESEND_API_KEY) {
//     throw new Error('Email is not configured (EMAIL_USER / EMAIL_PASS or RESEND_API_KEY are missing)');
//   }

//   const sender = from ?? env.emailFrom;
//   const message = { from: sender, to, subject, text, html };

//   let info;

//   if (env.isTest) {
//     info = await getTransport().sendMail(message);
//     outbox.push({ ...message, message: info.message });
//   } else if (process.env.RESEND_API_KEY) {
//     // Primary production route: HTTPS API (Port 443) - zero connection timeouts
//     info = await sendViaResendHttp({ to, from: sender, subject, text, html });
//   } else {
//     // Fallback: SMTP route
//     info = await getTransport().sendMail(message);
//   }

//   // Subject and recipient only. Never the body: it contains the reset URL.
//   logger.info('email dispatched', { to, subject, messageId: info.messageId });
//   return info;
// }

// /** Empties the test outbox. No effect outside the test environment. */
// export function resetOutbox() {
//   outbox.length = 0;
// }

// /**
//  * Sends without blocking, and without ever rejecting.
//  *
//  * Used on the password-reset request path. Awaiting the network round-trip there
//  * would make a request for a real account measurably slower than one for an unknown
//  * address -- which is exactly the timing signal that defeats a generic response.
//  */
// export function sendMailInBackground(message) {
//   sendMail(message).catch((error) => {
//     // Safe operational detail only: no recipient body, no token.
//     logger.error('email dispatch failed', { subject: message.subject, error: error.message });
//   });
// }

// // ---------------------------------------------------------------------------
// // CONVENIENCE: Password Reset Email (Resend HTTPS / SMTP)
// //
// // `from` is pinned to the Resend onboarding domain while testing with a free
// // Resend account. Once your custom domain is verified in the Resend dashboard,
// // you can replace it with your own verified domain.
// // ---------------------------------------------------------------------------

// /**
//  * Sends a password-reset link to the given address.
//  *
//  * @param {string} toEmail  – recipient email address
//  * @param {string} token    – signed reset token (never logged or returned to caller)
//  */
// export async function sendResetEmail(toEmail, token) {
//   const resetUrl = `${process.env.FRONTEND_URL ?? env.FRONTEND_URL}/reset-password?token=${token}`;

//   const from = process.env.RESEND_API_KEY
//     ? 'StockPulse <EMAIL_USER>'
//     : env.emailFrom;

//   await sendMail({
//     to: toEmail,
//     from,
//     subject: 'Reset your StockPulse password',
//     html: `
//       <p>Hello,</p>
//       <p>We received a request to reset the password for your StockPulse account.</p>
//       <p>
//         <a href="${resetUrl}" style="display:inline-block;padding:10px 20px;background:#0ea5e9;color:#fff;border-radius:6px;text-decoration:none;">
//           Reset password
//         </a>
//       </p>
//       <p>This link expires in ${env.RESET_TOKEN_TTL_MINUTES ?? 30} minutes.</p>
//       <p>If you did not request a password reset you can safely ignore this email.</p>
//     `,
//     text: `Reset your StockPulse password: ${resetUrl}\n\nThis link expires in ${env.RESET_TOKEN_TTL_MINUTES ?? 30} minutes.`,
//   });
// }

/**
 * Transactional email.
 *
 * Transport selection:
 *   1. NODE_ENV=test        → JSON mock; no network; records to outbox
 *   2. GMAIL_API_ENABLED    → Gmail API over HTTPS (port 443)
 *   3. RESEND_API_KEY       → Resend HTTPS API (port 443)
 *   4. Fallback              → Nodemailer SMTP
 */
import nodemailer from 'nodemailer';
import { google } from 'googleapis';

import { env } from '../config/env.js';
import { logger } from './logger.js';

/**
 * Messages produced in the test environment, oldest first.
 */
export const outbox = [];

let transporter = null;
let gmailClient = null;

// ---------------------------------------------------------------------------
// GMAIL API HTTPS TRANSPORT
// ---------------------------------------------------------------------------

function getGmailClient() {
  if (gmailClient) return gmailClient;

  const {
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REFRESH_TOKEN,
  } = process.env;

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error(
      'Gmail API is enabled, but GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ' +
      'or GOOGLE_REFRESH_TOKEN is missing'
    );
  }

  const oauth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET
  );

  oauth2Client.setCredentials({
    refresh_token: GOOGLE_REFRESH_TOKEN,
  });

  gmailClient = google.gmail({
    version: 'v1',
    auth: oauth2Client,
  });

  return gmailClient;
}

function encodeSubject(subject) {
  // RFC 2047 encoded-word format, supports non-ASCII subjects.
  return `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
}

function base64UrlEncode(value) {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function normalizeEmailAddress(value) {
  // Supports either "person@example.com" or "Name <person@example.com>".
  return String(value).replace(/[\r\n]/g, '').trim();
}

function buildRawEmail({ to, from, subject, text, html }) {
  const recipients = (Array.isArray(to) ? to : [to])
    .map(normalizeEmailAddress)
    .join(', ');

  const sender = normalizeEmailAddress(from);
  const safeSubject = encodeSubject(subject);
  const boundary = `stockpulse_${Date.now()}_${Math.random()
    .toString(16)
    .slice(2)}`;

  const headers = [
    `From: ${sender}`,
    `To: ${recipients}`,
    `Subject: ${safeSubject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];

  const parts = [];

  if (text) {
    parts.push(
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(text, 'utf8').toString('base64'),
    );
  }

  if (html) {
    parts.push(
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(html, 'utf8').toString('base64'),
    );
  }

  parts.push(`--${boundary}--`);

  return [...headers, '', ...parts].join('\r\n');
}

async function sendViaGmailApi({ to, from, subject, text, html }) {
  const gmail = getGmailClient();

  const rawMessage = buildRawEmail({
    to,
    from,
    subject,
    text,
    html,
  });

  logger.info('mailer: dispatching via Gmail API HTTPS');

  const response = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: base64UrlEncode(rawMessage),
    },
  });

  return {
    messageId: response.data.id,
    threadId: response.data.threadId,
    ...response.data,
  };
}

// ---------------------------------------------------------------------------
// RESEND HTTPS API
// ---------------------------------------------------------------------------

async function sendViaResendHttp({ to, from, subject, text, html }) {
  logger.info('mailer: dispatching via Resend HTTPS API');

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
    const errorMsg =
      data?.message ||
      data?.error ||
      response.statusText ||
      'Resend API request failed';

    throw new Error(`Resend API Error (${response.status}): ${errorMsg}`);
  }

  return { messageId: data.id, ...data };
}

// ---------------------------------------------------------------------------
// SMTP FALLBACK
// ---------------------------------------------------------------------------

function buildTransport() {
  if (env.isTest) {
    return nodemailer.createTransport({
      jsonTransport: true,
    });
  }

  logger.info('mailer: using SMTP transport', {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
  });

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
  if (!transporter) {
    transporter = buildTransport();
  }

  return transporter;
}

// ---------------------------------------------------------------------------
// PUBLIC EMAIL FUNCTION
// ---------------------------------------------------------------------------

export async function sendMail({
  to,
  subject,
  text,
  html,
  from,
}) {
  const gmailEnabled =
    process.env.GMAIL_API_ENABLED === 'true';

  if (
    !env.isTest &&
    !gmailEnabled &&
    !env.isEmailConfigured &&
    !process.env.RESEND_API_KEY
  ) {
    throw new Error(
      'Email is not configured. Set Gmail API, Resend, or SMTP credentials.'
    );
  }

  const sender =
    from ||
    process.env.EMAIL_FROM ||
    (gmailEnabled
      ? `StockPulse <${process.env.GMAIL_SENDER_EMAIL}>`
      : env.emailFrom);

  const message = {
    from: sender,
    to,
    subject,
    text,
    html,
  };

  let info;

  if (env.isTest) {
    info = await getTransport().sendMail(message);

    outbox.push({
      ...message,
      message: info.message,
    });
  } else if (gmailEnabled) {
    info = await sendViaGmailApi({
      to,
      from: sender,
      subject,
      text,
      html,
    });
  } else if (process.env.RESEND_API_KEY) {
    info = await sendViaResendHttp({
      to,
      from: sender,
      subject,
      text,
      html,
    });
  } else {
    info = await getTransport().sendMail(message);
  }

  // Do not log the body: it contains the password-reset URL/token.
  logger.info('email dispatched', {
    to,
    subject,
    messageId: info.messageId,
  });

  return info;
}

/** Empties the test outbox. No effect outside test environment. */
export function resetOutbox() {
  outbox.length = 0;
}

/**
 * Sends without blocking and without rejecting.
 */
export function sendMailInBackground(message) {
  sendMail(message).catch((error) => {
    logger.error('email dispatch failed', {
      subject: message.subject,
      error: error.message,
    });
  });
}

// ---------------------------------------------------------------------------
// PASSWORD RESET EMAIL
// ---------------------------------------------------------------------------

export async function sendResetEmail(toEmail, token) {
  const frontendUrl =
    process.env.FRONTEND_URL ?? env.FRONTEND_URL;

  const resetUrl = new URL('/reset-password', frontendUrl);
  resetUrl.searchParams.set('token', token);

  const gmailEnabled =
    process.env.GMAIL_API_ENABLED === 'true';

  const from =
    process.env.EMAIL_FROM ||
    (gmailEnabled
      ? `StockPulse <${process.env.GMAIL_SENDER_EMAIL}>`
      : env.emailFrom);

  await sendMail({
    to: toEmail,
    from,
    subject: 'Reset your StockPulse password',

    html: `
      <p>Hello,</p>
      <p>We received a request to reset the password for your StockPulse account.</p>
      <p>
        <a
          href="${resetUrl.toString()}"
          style="display:inline-block;padding:10px 20px;background:#0ea5e9;color:#fff;border-radius:6px;text-decoration:none;"
        >
          Reset password
        </a>
      </p>
      <p>This link expires in ${env.RESET_TOKEN_TTL_MINUTES ?? 30} minutes.</p>
      <p>If you did not request a password reset, you can safely ignore this email.</p>
    `,

    text:
      `Reset your StockPulse password: ${resetUrl.toString()}\n\n` +
      `This link expires in ${env.RESET_TOKEN_TTL_MINUTES ?? 30} minutes.`,
  });
}