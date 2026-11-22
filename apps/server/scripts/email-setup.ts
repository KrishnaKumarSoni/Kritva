/**
 * Sets up emailed sign-in links with Amazon SES, in one go (docs/Kritva_Sign_In.md, section 4).
 *
 *   npm run email:setup -- you@example.com                 set up, in your AWS profile's region
 *   npm run email:setup -- you@example.com --region us-east-1
 *   npm run email:setup -- you@example.com --from signin@yourdomain.com
 *
 * With your AWS credentials (the same ones the AWS CLI uses), it:
 * 1. checks SES in the region: whether sending is on and whether the account is still in the sandbox;
 * 2. asks SES to verify the address that sends and the address that signs in (AWS emails each one a
 *    link; already verified addresses are left alone);
 * 3. writes KRITVA_EMAIL_FROM, KRITVA_SIGNIN_EMAILS and KRITVA_SES_REGION into .env, keeping
 *    everything else in it.
 * Run it again any time: it only reports what is still missing. Then restart the server.
 *
 * Any SES region works. Where the email is sent from does not change how fast the console is.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CreateEmailIdentityCommand, GetAccountCommand, GetEmailIdentityCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { normalizeEmail } from "../src/auth.ts";
import { setEnvValues } from "../src/env-file.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const ENV = resolve(ROOT, ".env");

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? null) : null;
};
const email = normalizeEmail(args.find((a) => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.startsWith("--")));
if (!email) {
  console.log("Usage: npm run email:setup -- you@example.com [--region <aws-region>] [--from <sender address>]");
  process.exit(1);
}
const from = normalizeEmail(flag("from") ?? email);
if (!from) {
  console.log("--from is not an email address.");
  process.exit(1);
}

const client = new SESv2Client(flag("region") ? { region: flag("region")! } : {});
let region: string;
try {
  region = await client.config.region();
} catch {
  console.log("No AWS region is set. Add --region (for example --region us-east-1), or set one with `aws configure`.");
  process.exit(1);
}
console.log(`Amazon SES, region ${region}.`);

const fail = (error: unknown): never => {
  const e = error as { name?: string; message?: string };
  if (e.name === "CredentialsProviderError" || /credential/i.test(e.message ?? "")) console.log("No AWS credentials found. Run `aws configure` with a user allowed to use SES (or set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY), then run this again.");
  else if (e.name === "AccessDeniedException" || /not authorized|access denied/i.test(e.message ?? "")) console.log(`Your AWS user may not use SES in ${region} (${e.message}). Allow ses:GetAccount, ses:GetEmailIdentity, ses:CreateEmailIdentity and ses:SendEmail, or try another region with --region.`);
  else if (/UnrecognizedClient|InvalidClientTokenId|not.*subscribed|OptInRequired|region/i.test(`${e.name} ${e.message}`)) console.log(`SES isn't available to your account in ${region} (${e.name}: ${e.message}). Try another region with --region, for example us-east-1.`);
  else console.log(`SES said: ${e.name ?? "error"}: ${e.message ?? String(error)}`);
  process.exit(1);
};

// 1. The account in this region.
const account = await client.send(new GetAccountCommand({})).catch(fail);
if (account.SendingEnabled === false) console.log("Sending is paused for this SES account. Check the SES console's Account dashboard.");
const sandbox = account.ProductionAccessEnabled !== true;
console.log(sandbox ? "The account is in the SES sandbox: it can only send to verified addresses. That's fine for signing yourself in." : "The account has production access.");

// 2. The addresses: the sender always, and the one that signs in while in the sandbox.
const addresses = [...new Set(sandbox ? [from, email] : [from])];
let waiting = 0;
for (const address of addresses) {
  const known = await client.send(new GetEmailIdentityCommand({ EmailIdentity: address })).catch((error) => (error?.name === "NotFoundException" ? null : fail(error)));
  if (known?.VerifiedForSendingStatus) {
    console.log(`  ${address}: verified.`);
    continue;
  }
  if (!known) await client.send(new CreateEmailIdentityCommand({ EmailIdentity: address })).catch(fail);
  waiting += 1;
  console.log(`  ${address}: ${known ? "still waiting" : "asked"} for verification. Open the email from Amazon Web Services and click its link.`);
}

// 3. The settings.
const before = existsSync(ENV) ? readFileSync(ENV, "utf8") : "";
const after = setEnvValues(before, { KRITVA_EMAIL_FROM: `Kritva <${from}>`, KRITVA_SIGNIN_EMAILS: email, KRITVA_SES_REGION: region });
if (after !== before) writeFileSync(ENV, after);
console.log(`\n.env: KRITVA_EMAIL_FROM="Kritva <${from}>", KRITVA_SIGNIN_EMAILS=${email}, KRITVA_SES_REGION=${region}${after === before ? " (already set)" : ""}.`);
if (from.endsWith("@gmail.com") || from.endsWith("@yahoo.com") || from.endsWith("@outlook.com")) {
  console.log("Note: email sent through SES from a gmail.com (or similar) address can land in spam. If it does, mark it 'Not spam' once, or later use an address on a domain you own (--from).");
}
console.log(waiting ? `\nNext: click the verification link${waiting > 1 ? "s" : ""} AWS just emailed, then restart the server. Run this again to check.` : "\nAll set. Restart the server, then sign in with your email.");
