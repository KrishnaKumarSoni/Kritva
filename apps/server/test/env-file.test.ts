/** Updating .env in place (scripts/email-setup.ts). */
import { describe, expect, it } from "vitest";
import { setEnvValues } from "../src/env-file.ts";

describe("setEnvValues", () => {
  it("replaces keys where they are, keeps every other line, and adds missing keys at the end", () => {
    const before = "# Kritva\nOPENAI_API_KEY=sk-1\nKRITVA_SES_REGION=ap-south-1\n\n# phone\nKRITVA_PHONE_ROUTES=*=code\n";
    const after = setEnvValues(before, { KRITVA_SES_REGION: "us-east-1", KRITVA_EMAIL_FROM: "Kritva <a@b.co>", KRITVA_SIGNIN_EMAILS: "a@b.co" });
    expect(after).toBe('# Kritva\nOPENAI_API_KEY=sk-1\nKRITVA_SES_REGION=us-east-1\n\n# phone\nKRITVA_PHONE_ROUTES=*=code\n\nKRITVA_EMAIL_FROM="Kritva <a@b.co>"\nKRITVA_SIGNIN_EMAILS=a@b.co\n');
  });

  it("updates every line that sets a key, so a later duplicate can't win", () => {
    expect(setEnvValues("A=1\nB=2\nA=3\n", { A: "9" })).toBe("A=9\nB=2\nA=9\n");
  });

  it("starts a file that does not exist yet, and changes nothing when values are the same", () => {
    expect(setEnvValues("", { A: "1" })).toBe("A=1\n");
    expect(setEnvValues("A=1\n", { A: "1" })).toBe("A=1\n");
  });
});
