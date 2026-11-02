/**
 * Manual smoke-test for mailer.js
 *
 * Runs OUTSIDE the test environment (NODE_ENV=development) so the real
 * transport is used — either Resend SMTP or Gmail SMTP, whichever your
 * .env configures.
 *
 * Usage:
 *   node scripts/test-mailer.js [recipient@example.com]
 *
 * If no recipient is given, the script defaults to the EMAIL_USER address
 * already in .env.
 *
 * What it proves:
 *   ✅ Which transport was chosen (Resend or SMTP)
 *   ✅ Whether the SMTP connection succeeds
 *   ✅ Whether the email actually lands (check your inbox / Resend dashboard)
 */

import 'dotenv/config';

// ── resolve the destination ───────────────────────────────────────────────
const TO = process.argv[2] || process.env.EMAIL_USER?.trim();

if (!TO) {
  console.error(
    '❌  No recipient address.\n' +
    '    Pass one as an argument:  node scripts/test-mailer.js you@example.com\n' +
    '    or set EMAIL_USER in .env',
  );
  process.exit(1);
}

// ── detect which transport will be used BEFORE importing the module ───────
const usingResend = Boolean(process.env.RESEND_API_KEY);
console.log('\n🔍 Transport detection:');
console.log('   RESEND_API_KEY present :', usingResend ? '✅  YES → will use Resend SMTP (smtp.resend.com)' : '❌  NO');
console.log('   EMAIL_USER present      :', process.env.EMAIL_USER ? `✅  YES (${process.env.EMAIL_USER.trim()})` : '❌  NO');
console.log('   EMAIL_PASS present      :', process.env.EMAIL_PASS ? '✅  YES' : '❌  NO');
console.log('   Active transport        :', usingResend ? '📨  Resend' : '📧  Gmail / SMTP');
console.log();

// ── import the real mailer (after env is loaded) ──────────────────────────
const { sendResetEmail, sendMail } = await import('../src/lib/mailer.js');

// ── test 1: sendResetEmail ─────────────────────────────────────────────────
console.log(`📤  Sending password-reset email to: ${TO}`);
console.log('    (using sendResetEmail with a fake token)');

try {
  await sendResetEmail(TO, 'fake-test-token-abc123');
  console.log('✅  sendResetEmail succeeded!\n');
  console.log('    → Check your inbox / Resend dashboard for the reset email.');
} catch (err) {
  console.error('❌  sendResetEmail FAILED:');
  console.error('   ', err.message);
  if (err.responseCode) console.error('    SMTP code:', err.responseCode, err.response);
  console.log();
}

// ── test 2: plain sendMail ─────────────────────────────────────────────────
// When using Resend, `from` must be either:
//   (a) onboarding@resend.dev   ← Resend test sender (no verification needed)
//   (b) any address on a domain you have verified at resend.com/domains
// Using a gmail.com address as `from` will always get SMTP 550 from Resend.
const fromAddress = usingResend
  ? 'StockPulse <onboarding@resend.dev>'
  : undefined; // sendMail will fall back to env.emailFrom (EMAIL_USER)

console.log(`\n📤  Sending a plain sendMail test email to: ${TO}`);
console.log(`    from: ${fromAddress ?? process.env.EMAIL_USER}`);

try {
  const info = await sendMail({
    to: TO,
    from: fromAddress,
    subject: 'StockPulse mailer smoke-test ✅',
    text:
      'This is a plain-text test message from the StockPulse mailer smoke-test script.\n\n' +
      `Transport used: ${usingResend ? 'Resend (smtp.resend.com)' : 'SMTP (' + process.env.SMTP_HOST + ')'}`,
    html: `
      <p><strong>StockPulse mailer smoke-test</strong></p>
      <p>If you can read this, your mailer is working correctly.</p>
      <p>Transport used: <code>${usingResend ? 'Resend (smtp.resend.com)' : 'SMTP (' + process.env.SMTP_HOST + ')'}</code></p>
    `,
  });

  console.log('✅  sendMail succeeded!');
  if (info.messageId) console.log('    Message-ID:', info.messageId);
  console.log('\n    → Check your inbox for "StockPulse mailer smoke-test ✅"');
} catch (err) {
  console.error('❌  sendMail FAILED:');
  console.error('   ', err.message);
  if (err.responseCode) console.error('    SMTP code:', err.responseCode, err.response);
}

console.log('\n─────────────────────────────────────────────────');
console.log('Done.');
