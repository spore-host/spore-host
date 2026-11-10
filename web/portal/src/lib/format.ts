// Number, money, time and account formatting (brief §5 "Formatting", §6).
// Intl everywhere, so separators and decimals are never hand-built.

const LOCALE = "en-US";

const money = new Intl.NumberFormat(LOCALE, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const moneyFine = new Intl.NumberFormat(LOCALE, { style: "currency", currency: "USD", minimumFractionDigits: 4, maximumFractionDigits: 4 });
const integer = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });

/**
 * Dollars with 2 decimals and thousands separators: $2,106.00.
 * `fine` gives 4 decimals for sub-cent hourly rates, which only advanced shows.
 */
export function formatMoney(usd: number, opts: { fine?: boolean } = {}): string {
  if (!Number.isFinite(usd)) throw new RangeError(`not a money amount: ${usd}`);
  return (opts.fine ? moneyFine : money).format(usd);
}

/** An hourly rate: "$0.40 an hour". */
export function formatRate(usdPerHour: number, opts: { fine?: boolean } = {}): string {
  return `${formatMoney(usdPerHour, opts)} an hour`;
}

export function formatInteger(n: number): string {
  return integer.format(n);
}

/** A duration in words: "5 h 29 min", "45 min", "under 1 min". Rounds down to the minute. */
export function formatDuration(ms: number): string {
  if (ms < 60000) return "under 1 min";
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** A clock time: "4:15 pm". Lower-case am/pm, per the brief's copy. */
export function formatClock(d: Date, timeZone?: string): string {
  const s = new Intl.DateTimeFormat(LOCALE, { hour: "numeric", minute: "2-digit", hour12: true, timeZone }).format(d);
  return s.replace(/\s?(AM|PM)$/, (_, p: string) => ` ${p.toLowerCase()}`);
}

/** "12 s ago", "3 min ago", "2 h ago". For "last checked". */
export function formatAgo(ms: number): string {
  if (ms < 60000) return `${Math.max(0, Math.floor(ms / 1000))} s ago`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)} min ago`;
  return `${Math.floor(ms / 3600000)} h ago`;
}

/** "AWS account ending 9012". The full id appears only under Details (glossary). */
export function accountLabel(accountId: string): string {
  if (!/^\d{12}$/.test(accountId)) throw new RangeError("an AWS account id is 12 digits");
  return `AWS account ending ${accountId.slice(-4)}`;
}

/** "1 minute" / "4 minutes". */
export function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${formatInteger(n)} ${n === 1 ? one : many}`;
}
