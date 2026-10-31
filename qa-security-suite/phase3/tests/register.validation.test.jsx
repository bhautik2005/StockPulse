/**
 * Phase 3 :: Registration form -- client-side validation.
 *
 * The requirement is specific: a password shorter than 12 characters, or a
 * malformed email, must BLOCK submission. That is a statement about behaviour,
 * not about text appearing on screen, so every test here asserts both halves:
 *
 *   1. the user is told what is wrong (a message bound to the field), and
 *   2. the network is never touched (authApi.register was not called).
 *
 * Only the second one actually proves "blocked". A form that renders a message
 * and submits anyway passes half of these assertions, and that is exactly the
 * bug this file exists to catch.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

/*
 * The helper must be evaluated before the page: it is what registers the
 * `vi.mock` for services/endpoints.js, and importing the page first would pull
 * the real endpoints module into the graph before the mock is installed.
 */
import { authApi, renderWithAuth, resetAuthApi, settleAuthBoot } from '../helpers/render.jsx';
import { Register } from '../../../client/src/pages/Register.jsx';
import { successfulRegister } from '../helpers/doubles.js';

/** A password that satisfies every rule: 12+ characters, under bcrypt's 72-byte limit. */
const GOOD_PASSWORD = 'correct-horse-battery';

beforeEach(() => {
  resetAuthApi();
});

/** Fills the form and presses the submit button. */
function submitForm({ name = 'Ada Lovelace', email = 'ada@acme.test', password = GOOD_PASSWORD, confirm = password } = {}) {
  fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: name } });
  fireEvent.change(screen.getByLabelText(/work email/i), { target: { value: email } });
  fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: password } });
  fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: confirm } });
  fireEvent.click(screen.getByRole('button', { name: /create account/i }));
}

describe('Phase 3 :: Register -- password length', () => {
  it('blocks submission when the password is shorter than 12 characters', async () => {
    renderWithAuth(<Register />);
    await settleAuthBoot();

    submitForm({ password: 'elevenchars' }); // 11 characters, one below the rule

    expect(await screen.findByText(/at least 12 characters/i)).toBeInTheDocument();
    // The decisive assertion: no request was made.
    expect(authApi.register).not.toHaveBeenCalled();
    expect(authApi.login).not.toHaveBeenCalled();
  });

  it('blocks an 11-character password, one below the boundary', async () => {
    renderWithAuth(<Register />);
    await settleAuthBoot();

    // The off-by-one case. A `<= 12` and a `< 12` check both pass the longer
    // test above; only a boundary case distinguishes them.
    submitForm({ password: 'elevenchars' });
    expect(await screen.findByText(/at least 12 characters/i)).toBeInTheDocument();
    expect(authApi.register).not.toHaveBeenCalled();
  });

  it('accepts exactly 12 characters, so the boundary is not stricter than documented', async () => {
    renderWithAuth(<Register />);
    await settleAuthBoot();
    // Configured AFTER the boot hydration on purpose: `successfulRegister` also
    // resolves `/me`, so setting it up first would boot the app as already signed
    // in and the form would redirect away before the test could fill it in.
    successfulRegister(authApi);

    submitForm({ password: 'twelvechars!' }); // exactly 12

    await waitFor(() => expect(authApi.register).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/at least 12 characters/i)).not.toBeInTheDocument();
  });

  it('blocks a password longer than 72 characters instead of letting bcrypt truncate it', async () => {
    renderWithAuth(<Register />);
    await settleAuthBoot();

    // bcrypt reads only the first 72 bytes. Accepting a longer password would
    // mean characters 73+ are silently ignored -- two different passwords that
    // both work.
    submitForm({ password: 'a'.repeat(73) });

    expect(await screen.findByText(/at most 72 characters/i)).toBeInTheDocument();
    expect(authApi.register).not.toHaveBeenCalled();
  });

  it('accepts exactly 72 characters', async () => {
    renderWithAuth(<Register />);
    await settleAuthBoot();
    // Configured AFTER the boot hydration on purpose: `successfulRegister` also
    // resolves `/me`, so setting it up first would boot the app as already signed
    // in and the form would redirect away before the test could fill it in.
    successfulRegister(authApi);

    submitForm({ password: 'a'.repeat(72) });

    await waitFor(() => expect(authApi.register).toHaveBeenCalledTimes(1));
  });

  it('marks the password input invalid for assistive technology, not just visually', async () => {
    renderWithAuth(<Register />);
    await settleAuthBoot();

    submitForm({ password: 'short' });

    const input = screen.getByLabelText(/^password/i);
    await waitFor(() => expect(input).toHaveAttribute('aria-invalid', 'true'));
    // aria-describedby ties the message to the field, so a screen reader reads
    // the reason rather than an unexplained "invalid".
    expect(input.getAttribute('aria-describedby')).toBeTruthy();
  });
});

describe('Phase 3 :: Register -- email format', () => {
  const BAD_EMAILS = [
    ['no at sign', 'ada.acme.test'],
    ['no domain', 'ada@'],
    ['no local part', '@acme.test'],
    ['no TLD', 'ada@acme'],
    ['whitespace inside', 'ada lovelace@acme.test'],
    ['two at signs', 'ada@@acme.test'],
    ['empty', ''],
  ];

  for (const [label, email] of BAD_EMAILS) {
    it(`blocks submission for a malformed email (${label})`, async () => {
      renderWithAuth(<Register />);
      await settleAuthBoot();

      submitForm({ email });

      expect(await screen.findByText(/valid email address/i)).toBeInTheDocument();
      expect(authApi.register).not.toHaveBeenCalled();
    });
  }

  it('accepts a well-formed email and submits', async () => {
    renderWithAuth(<Register />);
    await settleAuthBoot();
    // Configured AFTER the boot hydration on purpose: `successfulRegister` also
    // resolves `/me`, so setting it up first would boot the app as already signed
    // in and the form would redirect away before the test could fill it in.
    successfulRegister(authApi);

    submitForm({ email: 'ada.lovelace+procurement@acme.co.uk' });

    await waitFor(() => expect(authApi.register).toHaveBeenCalledTimes(1));
  });
});

describe('Phase 3 :: Register -- other client-side rules', () => {
  it('requires the two passwords to match', async () => {
    renderWithAuth(<Register />);
    await settleAuthBoot();

    submitForm({ password: GOOD_PASSWORD, confirm: `${GOOD_PASSWORD}-typo` });

    expect(await screen.findByText(/do not match/i)).toBeInTheDocument();
    expect(authApi.register).not.toHaveBeenCalled();
  });

  it('requires a name of at least two characters', async () => {
    renderWithAuth(<Register />);
    await settleAuthBoot();

    submitForm({ name: 'A' });

    expect(await screen.findByText(/enter your name/i)).toBeInTheDocument();
    expect(authApi.register).not.toHaveBeenCalled();
  });

  it('reports every invalid field at once rather than one at a time', async () => {
    renderWithAuth(<Register />);
    await settleAuthBoot();

    // An empty submit. Fixing a form one error per attempt is a miserable
    // experience and usually means validation returns early.
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText(/enter your name/i)).toBeInTheDocument();
    expect(screen.getByText(/valid email address/i)).toBeInTheDocument();
    expect(screen.getByText(/at least 12 characters/i)).toBeInTheDocument();
    expect(authApi.register).not.toHaveBeenCalled();
  });

  it('trims surrounding whitespace from the name and email before sending', async () => {
    renderWithAuth(<Register />);
    await settleAuthBoot();
    // Configured AFTER the boot hydration on purpose: `successfulRegister` also
    // resolves `/me`, so setting it up first would boot the app as already signed
    // in and the form would redirect away before the test could fill it in.
    successfulRegister(authApi);

    submitForm({ name: '  Ada Lovelace  ', email: '  ada@acme.test  ' });

    await waitFor(() => expect(authApi.register).toHaveBeenCalledTimes(1));
    expect(authApi.register).toHaveBeenCalledWith({
      name: 'Ada Lovelace',
      email: 'ada@acme.test',
      password: GOOD_PASSWORD,
    });
  });

  it('does not leak the password into the submitted name or email fields', async () => {
    renderWithAuth(<Register />);
    await settleAuthBoot();
    // Configured AFTER the boot hydration on purpose: `successfulRegister` also
    // resolves `/me`, so setting it up first would boot the app as already signed
    // in and the form would redirect away before the test could fill it in.
    successfulRegister(authApi);

    submitForm();
    await waitFor(() => expect(authApi.register).toHaveBeenCalledTimes(1));

    const [payload] = authApi.register.mock.calls[0];
    expect(Object.keys(payload).sort()).toEqual(['email', 'name', 'password']);
    // The confirm field is a client-side concern only; sending it would invite
    // the server to trust a value it does not need.
    expect(payload).not.toHaveProperty('confirm');
  });
});
