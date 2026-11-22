/**
 * Listing codes: the four digits a caller gives on Kritva's shared phone line so the call reaches the
 * right mandate (docs/Kritva_Phone_Calls.md, "Listing codes and the front desk").
 *
 * A code is three digits (100 to 999) and a Damm check digit. The Damm algorithm detects every
 * single-digit error and every swap of two neighbouring digits, so a misheard or mistyped code is
 * invalid rather than another listing's code: Kritva asks again instead of reading back the wrong
 * listing. That leaves 900 codes.
 */

/** The Damm algorithm's quasigroup table (a weakly totally anti-symmetric quasigroup of order 10). */
const DAMM = [
  [0, 3, 1, 7, 5, 9, 8, 6, 4, 2],
  [7, 0, 9, 2, 1, 5, 4, 8, 6, 3],
  [4, 2, 0, 6, 8, 7, 1, 3, 5, 9],
  [1, 7, 5, 0, 9, 8, 3, 4, 2, 6],
  [6, 1, 2, 3, 0, 4, 5, 9, 7, 8],
  [3, 6, 7, 4, 2, 0, 9, 5, 8, 1],
  [5, 8, 6, 9, 7, 2, 0, 1, 3, 4],
  [8, 9, 4, 5, 3, 6, 2, 0, 1, 7],
  [9, 4, 3, 8, 6, 1, 7, 2, 0, 5],
  [2, 5, 8, 1, 4, 3, 6, 7, 9, 0],
] as const;

const interim = (digits: string) => [...digits].reduce((row, d) => DAMM[row]![Number(d)]!, 0);

/** The Damm check digit for a string of ASCII digits. */
export function dammCheckDigit(digits: string): number {
  if (!/^\d+$/.test(digits)) throw new Error("dammCheckDigit takes digits only");
  return interim(digits);
}

/** Four digits, the first not 0, whose last digit is the Damm check digit of the first three. */
export function isListingCode(code: string): boolean {
  return /^[1-9]\d{3}$/.test(code) && interim(code) === 0;
}

/** The code for three data digits (100 to 999). */
export function listingCodeFor(base: number): string {
  if (!Number.isInteger(base) || base < 100 || base > 999) throw new Error("A listing code's base is 100 to 999");
  return `${base}${dammCheckDigit(String(base))}`;
}

/** Zero of each Unicode digit block a caller's words may be written in (the transcript keeps the caller's script). */
const DIGIT_ZEROS = [0x30, 0x660, 0x6f0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66, 0xff10];

/**
 * The digits in what was heard or typed: "4 8 2 1", "4-821", "४८२१" and "௪௮௨௧" all give "4821".
 * Anything that is not a digit is dropped; spoken number words are the voice model's to turn into digits.
 */
export function listingCodeDigits(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const cp = ch.codePointAt(0)!;
    const zero = DIGIT_ZEROS.find((z) => cp >= z && cp <= z + 9);
    if (zero !== undefined) out += String(cp - zero);
  }
  return out;
}

/**
 * A new code that is not in `taken`. Codes never used come first, chosen at random; when all 900 are
 * used, the one released longest ago (first in `released`, oldest first) is reused. Null when every
 * code is held by a mandate.
 */
export function pickListingCode(taken: ReadonlySet<string>, released: readonly string[], random: () => number = Math.random): string | null {
  const used = new Set([...taken, ...released]);
  const fresh: string[] = [];
  for (let base = 100; base <= 999; base += 1) {
    const code = listingCodeFor(base);
    if (!used.has(code)) fresh.push(code);
  }
  if (fresh.length) return fresh[Math.floor(random() * fresh.length)]!;
  return released.find((code) => !taken.has(code)) ?? null;
}
