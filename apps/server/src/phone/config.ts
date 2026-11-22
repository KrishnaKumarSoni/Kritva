/**
 * Phone call settings (docs/Kritva_Phone_Calls.md, "Configuration"). Read once at start-up.
 *
 * Phone calls are on when OPENAI_WEBHOOK_SECRET and KRITVA_PHONE_ROUTES are both set (and the
 * server has OPENAI_API_KEY with realtime voice on). Nothing here is a secret except the webhook
 * secret, which is only used to verify OpenAI's signature.
 */

/**
 * Where a dialled number leads: a demo listing (by case ID), a saved library mandate (by ID), or
 * "code": the shared line's front desk, which asks for the listing code and reaches that mandate
 * (front-desk.ts).
 */
export type PhoneTarget = { kind: "listing"; caseId: string } | { kind: "mandate"; mandateId: string } | { kind: "code" };

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
  /** OpenAI's SIP host. Default: the global host (GeoIP-routed), the one OpenAI documents for Twilio. */
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
  /** "minimal": accept with model, instructions and voice, then send the session as session.update (default). "full": all in the accept. */
  acceptMode: "minimal" | "full";
  /** Log every sideband event type and the masked SIP headers of each call (KRITVA_PHONE_TRACE=1), for diagnosing a call. */
  trace: boolean;
  /**
   * Public names the shared line answers for (KRITVA_PHONE_ANSWERS_FOR, comma-separated), so the front
   * desk can say yes to "Is this ABC Corporation?" before the code. Demo listings add their own public
   * principal names. Never read out to callers.
   */
  answersFor?: string[];
}

/** OpenAI's global SIP host, routed by the caller's location (https://developers.openai.com/api/docs/guides/realtime-sip). */
export const GLOBAL_SIP_HOST = "sip.api.openai.com";
/** OpenAI's India edge, for a provider whose media servers are in India; KRITVA_PHONE_SIP_HOST selects it. Twilio's are not. */
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
 * ("bed-sale", or "listing:bed-sale"), a saved mandate ("mandate:man_..."), or "code" for the shared
 * line's front desk, which asks for the listing code. "*" matches any number, for a single-number
 * setup or when the provider's headers do not carry the dialled number.
 * Examples: "+918071234567=bed-sale,*=bed-sale", "+918071234567=code,*=code".
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
  if (raw === "code") return { kind: "code" };
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
    sipHost: env.KRITVA_PHONE_SIP_HOST?.trim() || GLOBAL_SIP_HOST,
    routes: parsed.routes,
    countryCode,
    noiseReduction: noise === "far_field" ? "far_field" : noise === "off" ? null : "near_field",
    idleMs: seconds(env.KRITVA_PHONE_IDLE_SECONDS, 30, 10, 300) * 1000,
    maxCallMs: seconds(env.KRITVA_PHONE_MAX_MINUTES, 15, 1, 120) * 60_000,
    maxCalls: Math.round(seconds(env.KRITVA_PHONE_MAX_CALLS, 5, 1, 100)),
    acceptMode: env.KRITVA_PHONE_ACCEPT === "full" ? "full" : "minimal",
    trace: env.KRITVA_PHONE_TRACE === "1",
    answersFor: (env.KRITVA_PHONE_ANSWERS_FOR ?? "").split(",").map((n) => n.trim().slice(0, 100)).filter(Boolean).slice(0, 20),
  };
  return { settings: webhookSecret && parsed.routes.length ? settings : null, problems };
}

/** The line's own number, for showing next to a listing code: the first route with a number, as +digits. Null with only "*". */
export function lineNumber(settings: Pick<PhoneSettings, "routes">): string | null {
  const route = settings.routes.find((r) => r.number !== "*");
  return route ? `+${route.number}` : null;
}

/** Whether a call can reach the front desk that asks for listing codes. */
export function usesListingCodes(settings: Pick<PhoneSettings, "routes">): boolean {
  return settings.routes.some((r) => r.target.kind === "code");
}

/**
 * OpenAI's SIP address for the project, over TLS, as Twilio's `<Dial><Sip>` dials it
 * (https://developers.openai.com/api/docs/guides/realtime-sip).
 */
export function sipUri(settings: Pick<PhoneSettings, "projectId" | "sipHost">): string {
  return `sip:${settings.projectId ?? "proj_YOUR_PROJECT_ID"}@${settings.sipHost};transport=tls`;
}

/** Twilio's account credentials (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN), or null when either is missing. */
export function twilioFromEnv(env: NodeJS.ProcessEnv): { accountSid: string; authToken: string } | null {
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = env.TWILIO_AUTH_TOKEN?.trim();
  return accountSid && authToken ? { accountSid, authToken } : null;
}

/** Outbound calling settings (Kritva dials counterparties through Twilio). See outbound.ts. */
export interface OutboundConfig {
  accountSid: string;
  authToken: string;
  /** Kritva's Twilio number, digits with country code. */
  callerId: string;
  publicUrl: string;
  bridgeUri: string;
  /** Numbers Kritva may call (digits with country code), or ["*"]. Empty until calling is approved. */
  allow: string[];
  maxCalls: number;
  timeLimitSeconds: number;
  countryCode: string;
}

/**
 * Outbound calls are on when phone calls are on and TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
 * KRITVA_PHONE_CALLER_ID (Kritva's Twilio number), KRITVA_PUBLIC_URL (https, reachable by Twilio)
 * and OPENAI_PROJECT_ID are set. KRITVA_PHONE_OUTBOUND_ALLOW lists the numbers that may be called
 * ("*" for any); without it nothing can be dialled, which is the safe default.
 */
export function outboundFromEnv(env: NodeJS.ProcessEnv, phone: PhoneSettings): { config: OutboundConfig | null; problems: string[] } {
  const problems: string[] = [];
  const need = (name: string) => {
    const value = env[name]?.trim();
    if (!value) problems.push(`${name} is not set.`);
    return value ?? "";
  };
  const accountSid = need("TWILIO_ACCOUNT_SID");
  const authToken = need("TWILIO_AUTH_TOKEN");
  const callerRaw = need("KRITVA_PHONE_CALLER_ID");
  const publicUrl = need("KRITVA_PUBLIC_URL");
  if (!phone.projectId) problems.push("OPENAI_PROJECT_ID is not set.");
  if (publicUrl && !/^https:\/\//.test(publicUrl)) problems.push("KRITVA_PUBLIC_URL must start with https://.");
  const callerId = callerRaw ? normalizeNumber(callerRaw, phone.countryCode) : "";
  if (callerRaw && !/^\d{10,15}$/.test(callerId)) problems.push("KRITVA_PHONE_CALLER_ID is not a phone number.");
  const allow = (env.KRITVA_PHONE_OUTBOUND_ALLOW ?? "").split(",").map((n) => n.trim()).filter(Boolean).map((n) => (n === "*" ? "*" : normalizeNumber(n, phone.countryCode)));
  if (problems.length) return { config: null, problems };
  return {
    config: {
      accountSid,
      authToken,
      callerId,
      publicUrl,
      bridgeUri: sipUri(phone),
      allow,
      maxCalls: phone.maxCalls,
      timeLimitSeconds: Math.round(phone.maxCallMs / 1000),
      countryCode: phone.countryCode,
    },
    problems,
  };
}
