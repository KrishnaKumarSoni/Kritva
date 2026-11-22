/** The shared phone line, as the principal shows it next to a listing code. */
import type { PhoneLine } from "./api.ts";

/** Indian metro area codes with 8-digit numbers after them (Delhi, Pune, Mumbai, Kolkata, Hyderabad, Chennai, Ahmedabad, Bengaluru). */
const METRO_CODES = ["11", "20", "22", "33", "40", "44", "79", "80"];

/**
 * The line's number as people write it. The line is a landline or toll-free number (a phone provider's
 * DID), so "+918064264194" reads "+91 80 6426 4194". Anything else stays ungrouped, so it is never
 * grouped wrongly.
 */
export function formatLineNumber(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  if (digits.length !== 12 || !digits.startsWith("91")) return e164;
  const n = digits.slice(2);
  if (METRO_CODES.includes(n.slice(0, 2))) return `+91 ${n.slice(0, 2)} ${n.slice(2, 6)} ${n.slice(6)}`;
  return `+91 ${n}`;
}

/** The line's number when calls reach the front desk that asks for codes; null otherwise. */
export function lineNumberFor(line: PhoneLine | null): string | null {
  return line?.listingCodes && line.number ? formatLineNumber(line.number) : null;
}

/** The line to paste into a listing or ad. */
export function adLine(code: string, line: PhoneLine | null): string {
  const number = lineNumberFor(line);
  return number ? `Call ${number} and give listing code ${code}.` : `Listing code: ${code}`;
}
