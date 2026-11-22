/** One language and its own script per reply: a word in another Indian script is caught. */
import { describe, expect, it } from "vitest";
import { strayScript } from "../../src/negotiation/engine.ts";

describe("strayScript", () => {
  it("catches Tamil and Devanagari words in an English reply", () => {
    expect(strayScript("அரே, समझ गई. If it helps, make me your best offer.", "English")).toBe("Devanagari");
    expect(strayScript("அரே, okay. What are you thinking?", "English")).toBe("Tamil");
  });

  it("allows a Hindi reply with English words, and catches Tamil in it", () => {
    expect(strayScript("समझ गई, 20,000 आपके लिए heavy लग रहा है.", "Hindi")).toBeNull();
    expect(strayScript("அரே, समझ गई.", "Hindi")).toBe("Tamil");
  });

  it("keeps typed Hindi in Latin letters", () => {
    expect(strayScript("Haan bhai, 18,000 mein ho jayega.", "Hindi, typed in Latin letters the way they wrote it")).toBeNull();
    expect(strayScript("हाँ भाई, ho jayega.", "Hindi, typed in Latin letters the way they wrote it")).toBe("Devanagari");
  });

  it("checks nothing before they have spoken", () => {
    expect(strayScript("नमस्ते! मैं Kritva हूँ.", null)).toBeNull();
  });
});
