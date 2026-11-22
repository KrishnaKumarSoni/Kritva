/**
 * Phone call settings (docs/Kritva_Phone_Calls.md, "Configuration"). Read once at start-up.
 *
 * Phone calls are on when OPENAI_WEBHOOK_SECRET and KRITVA_PHONE_ROUTES are both set (and the
 * server has OPENAI_API_KEY with realtime voice on). Nothing here is a secret except the webhook
 * secret, which is only used to verify OpenAI's signature.
 */

/** Where a dialled number leads: a demo listing (by case ID) or a saved library mandate (by ID). */
export type PhoneTarget = { kind: "listing"; caseId: string } | { kind: "mandate"; mandateId: string };

export interface PhoneRoute {
  /** Digits only, with the country code ("918071234567"), or "*" for any number not listed. */
  number: string;
  target: PhoneTarget;
}

export type NoiseReduction = "near_field" | "far_field" | null;

export interface PhoneSettings {
  /** OpenAI's webhook signing secret ("whsec_..."), from the project's webhook settings. */
  webhookSecret: string;
  /** The OpenAI project ID ("proj_..."), the user part of the SIP URI. Only used to print the setup values. */
  projectId: string | null;
  /** OpenAI's SIP host. Default: the India edge, for callers in India. */
  sipHost: string;
  routes: PhoneRoute[];
  /** Country code assumed for numbers written without one ("080 7123 4567" in India). */
  countryCode: string;
  noiseReduction: NoiseReduction;
  /** Silence before Kritva checks the caller is still there; the same again before it hangs up. */
  idleMs: number;
  /** The longest a call may run before Kritva closes it politely. */
  maxCallMs: number;
  /** Calls at once; more are declined as busy. */
  maxCalls: number;
}

/** The India edge of OpenAI's SIP endpoint (https://developers.openai.com/api/docs/guides/realtime-sip). */
export const INDIA_SIP_HOST = "sip-in.api.openai.com";

/** A phone number as digits with its country code: "+91 80 7123 4567", "080 7123 4567" and "8071234567" all become "918071234567". */
export function normalizeNumber(raw: string, countryCode = "91"): string {
  const trimmed = raw.trim();
  let digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) return digits;
  if (digits.startsWith("00")) return digits.slice(2);
  if (digits.startsWith("0") && digits.length === 11) digits = digits.slice(1);
  return digits.length === 10 ? `${countryCode}${digits}` : digits;
}

/**
 * KRITVA_PHONE_ROUTES: comma-separated `number=target` pairs. A target is a listing's case ID
 * ("bed-sale", or "listing:bed-sale") or a saved mandate ("mandate:man_..."). "*" matches any
 * number, for a single-number setup or when the provider's headers do not carry the dialled number.
 * Example: "+918071234567=bed-sale,*=bed-sale".
 */
export function parseRoutes(value: string, countryCode = "91"): { routes: PhoneRoute[]; problems: string[] } {
  const routes: PhoneRoute[] = [];
  const problems: string[] = [];
  for (const pair of value.split(",").map((p) => p.trim()).filter(Boolean)) {
    const [rawNumber, rawTarget] = pair.split("=").map((s) => s?.trim() ?? "");
    const target = parseTarget(rawTarget ?? "");
    const number = rawNumber === "*" ? "*" : normalizeNumber(rawNumber ?? "", countryCode);
    if (!target || (number !== "*" && !/^\d{8,15}$/.test(number))) {
      problems.push(`KRITVA_PHONE_ROUTES: "${pair}" is not a number=target pair.`);
      continue;
    }
    routes.push({ number, target });
  }
  return { routes, problems };
}

function parseTarget(raw: string): PhoneTarget | null {
  if (raw.startsWith("mandate:")) return /^[\w-]{1,128}$/.test(raw.slice(8)) ? { kind: "mandate", mandateId: raw.slice(8) } : null;
  const caseId = raw.startsWith("listing:") ? raw.slice(8) : raw;
  return /^[\w-]{1,128}$/.test(caseId) ? { kind: "listing", caseId } : null;
}

const seconds = (value: string | undefined, fallback: number, min: number, max: number) => {
  const n = Number(value);
  return Number.isFinite(n) && value !== undefined && value !== "" ? Math.min(max, Math.max(min, n)) : fallback;
};

/** The settings, or null with the reasons phone calls are off. */
export function phoneSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): { settings: PhoneSettings | null; problems: string[] } {
  const problems: string[] = [];
  const webhookSecret = env.OPENAI_WEBHOOK_SECRET?.trim() ?? "";
  if (!webhookSecret) problems.push("OPENAI_WEBHOOK_SECRET is not set.");
  const countryCode = /^\d{1,3}$/.test(env.KRITVA_PHONE_COUNTRY_CODE ?? "") ? env.KRITVA_PHONE_COUNTRY_CODE! : "91";
  const parsed = parseRoutes(env.KRITVA_PHONE_ROUTES ?? "", countryCode);
  problems.push(...parsed.problems);
  if (!parsed.routes.length) problems.push("KRITVA_PHONE_ROUTES has no number=target pairs.");
  const projectId = env.OPENAI_PROJECT_ID?.trim() || null;
  if (projectId && !/^proj_\w+$/.test(projectId)) problems.push("OPENAI_PROJECT_ID should look like proj_...");
  const noise = env.KRITVA_PHONE_NOISE_REDUCTION;
  const settings: PhoneSettings = {
    webhookSecret,
    projectId,
    sipHost: env.KRITVA_PHONE_SIP_HOST?.trim() || INDIA_SIP_HOST,
    routes: parsed.routes,
    countryCode,
    noiseReduction: noise === "far_field" ? "far_field" : noise === "off" ? null : "near_field",
    idleMs: seconds(env.KRITVA_PHONE_IDLE_SECONDS, 30, 10, 300) * 1000,
    maxCallMs: seconds(env.KRITVA_PHONE_MAX_MINUTES, 15, 1, 120) * 60_000,
    maxCalls: Math.round(seconds(env.KRITVA_PHONE_MAX_CALLS, 5, 1, 100)),
  };
  return { settings: webhookSecret && parsed.routes.length ? settings : null, problems };
}

/**
 * The SIP URI the phone provider sends calls to. Vobiz needs the explicit TLS port (5061) and has
 * TLS chosen in its console; other providers take `;transport=tls` instead
 * (https://www.vobiz.ai/docs/integrations/openai-realtime).
 */
export function sipUri(settings: Pick<PhoneSettings, "projectId" | "sipHost">): string {
  return `sip:${settings.projectId ?? "proj_YOUR_PROJECT_ID"}@${settings.sipHost}:5061`;
}
