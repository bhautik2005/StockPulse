/**
 * Display formatting.
 *
 * Money crosses the API as an exact decimal *string* ("448.70") precisely
 * because JavaScript numbers are binary floats. Parsing one for display is
 * safe -- the formatter rounds to the currency's precision anyway -- but no
 * arithmetic is ever done on these values in the browser. Totals come from the
 * server, which computes them in NUMERIC.
 */

const currencyCache = new Map();

function currencyFormatter(currency) {
  if (!currencyCache.has(currency)) {
    currencyCache.set(
      currency,
      new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
    );
  }
  return currencyCache.get(currency);
}

export function formatMoney(value, currency = 'USD') {
  if (value === null || value === undefined || value === '') return '—';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return String(value);
  return currencyFormatter(currency).format(amount);
}

/** Money without the symbol, for dense columns where the header carries it. */
export function formatAmount(value) {
  if (value === null || value === undefined || value === '') return '—';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return String(value);
  return amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatNumber(value) {
  if (value === null || value === undefined || value === '') return '—';
  const amount = Number(value);
  return Number.isFinite(amount) ? amount.toLocaleString('en-US') : String(value);
}

export function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "3 hours ago" -- useful in activity feeds where the ordering is the point. */
export function formatRelative(value) {
  if (!value) return '—';
  const then = new Date(value).getTime();
  const seconds = Math.round((Date.now() - then) / 1000);

  const units = [
    ['year', 31536000],
    ['month', 2592000],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];

  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) {
      const count = Math.round(seconds / size);
      return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(-count, unit);
    }
  }
  return 'just now';
}

/** "SP-MON-27-03" -> "SP-MON...". Keeps tables from stretching on long SKUs. */
export function truncate(value, length = 32) {
  const text = String(value ?? '');
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

export function initialsOf(name = '') {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

/** Chart axis labels: "2026-10-04" -> "Oct 4". */
export function shortDay(day) {
  const [, month, date] = String(day).split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(month) - 1] ?? month} ${Number(date)}`;
}