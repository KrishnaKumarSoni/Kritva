/**
 * Reading phone numbers from the SIP INVITE headers that OpenAI's `realtime.call.incoming` webhook
 * passes on (`data.sip_headers`: `{ name, value }` pairs, in order, untrusted).
 *
 * Kritva's Twilio Voice URL adds X-Kritva-Called (the number dialled) and X-Kritva-Caller (who is
 * calling) to the call it hands to OpenAI. Other places are checked too, most specific first, and
 * routing takes the first number that matches a configured route. A "*" route covers a call with no
 * usable number. The incoming-call log lists the header names of each call.
 */
import { normalizeNumber, type PhoneRoute } from "./config.ts";

export interface SipHeader {
  name: string;
  value: string;
}

/** Custom headers some providers add with the number that was dialled. */
const DIALLED_HEADER = /^x-.*(did|called|dialed|dialled|destination|to-?number|original-?to)/i;
/** Standard headers that can carry the dialled number, in the order they are checked. */
const DIALLED_STANDARD = ["to", "p-called-party-id", "diversion", "history-info"];
/** Headers that carry who is calling, most trusted first. */
const CALLER = ["x-kritva-caller", "p-asserted-identity", "remote-party-id", "from"];

/** The phone number in a header value: `<sip:+918071234567@host;user=phone>;tag=1`, `tel:+91...` or a bare number. */
export function numberIn(value: string): string | null {
  const uri = /(?:sips?|tel):\s*([^@;>\s]+)/i.exec(value);
  const user = (uri ? uri[1]! : value).replace(/[\s().-]/g, "");
  return /^\+?\d{6,15}$/.test(user) ? user : null;
}

const named = (headers: SipHeader[], name: string) => headers.filter((h) => h.name.toLowerCase() === name);

/** Numbers that may be the one dialled, most likely first, each as digits with the country code. */
export function dialledNumbers(headers: SipHeader[], countryCode = "91"): string[] {
  const ordered = [...headers.filter((h) => DIALLED_HEADER.test(h.name)), ...DIALLED_STANDARD.flatMap((n) => named(headers, n))];
  const out: string[] = [];
  for (const h of ordered) {
    const n = numberIn(h.value);
    if (n) out.push(normalizeNumber(n, countryCode));
  }
  return [...new Set(out)];
}

/** The caller's number, or null when withheld or not a number. */
export function callerNumber(headers: SipHeader[], countryCode = "91"): string | null {
  for (const name of CALLER) {
    for (const h of named(headers, name)) {
      const n = numberIn(h.value);
      if (n) return normalizeNumber(n, countryCode);
    }
  }
  return null;
}

/** A number safe to log: the country code and last four digits only ("91******4567"). */
export function maskNumber(digits: string | null): string | null {
  if (!digits) return null;
  return digits.length <= 6 ? "****" : `${digits.slice(0, 2)}${"*".repeat(digits.length - 6)}${digits.slice(-4)}`;
}

/** The route for a call: the first dialled number with its own route, else the "*" route. */
export function routeFor(headers: SipHeader[], routes: PhoneRoute[], countryCode = "91"): { route: PhoneRoute | null; dialled: string[] } {
  const dialled = dialledNumbers(headers, countryCode);
  for (const number of dialled) {
    const route = routes.find((r) => r.number === number);
    if (route) return { route, dialled };
  }
  return { route: routes.find((r) => r.number === "*") ?? null, dialled };
}
