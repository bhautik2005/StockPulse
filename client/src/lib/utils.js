import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Conditional classes without Tailwind conflicts (last-wins for utilities). */
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

/** Builds a query string, dropping empty values so `?status=` never appears. */
export function toQuery(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

/** Debounces a function; used by the search inputs. */
export function debounce(fn, delay = 350) {
  let timer;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
  debounced.cancel = () => clearTimeout(timer);
  return debounced;
}

/**
 * A fresh idempotency key for an order submission.
 *
 * The key is what makes "the response never arrived, try again" safe: the server
 * recognises the retry and returns the original order rather than creating a
 * second one. `crypto.randomUUID` requires a secure context, and serving the
 * built app over plain HTTP on a LAN address is not one, so there is a fallback
 * that still produces a valid v4-shaped UUID.
 */
export function newIdempotencyKey() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}