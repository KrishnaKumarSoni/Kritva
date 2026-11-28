/**
 * Kritva's landing page, at "/". Every other address is the console (App.tsx), so sign-in works as it
 * always did: "Sign in" opens /signin and "Start a test negotiation" opens /negotiations, where the
 * curtain carries the email-link and passkey forms when nobody is signed in.
 *
 * Show, not tell: the hero runs a live deal board, the safety section runs one turn through both gates.
 */
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { ArrowRightIcon, LockIcon, MicIcon, PhoneIcon, PlusIcon } from "../icons.tsx";
import { HeroBoard } from "./HeroBoard.tsx";
import { TurnDemo } from "./TurnDemo.tsx";
import { UseCases } from "./UseCases.tsx";
import { ArrowDownIcon, ChatIcon, LanguageIcon, Mark, Rings, XSmallIcon } from "./marks.tsx";
import "./landing.css";

const START = "/negotiations";
const SIGN_IN = "/signin";
const ease = [0.2, 0, 0, 1] as const;

const NAV = [
  { href: "#how", label: "How it works" },
  { href: "#safety", label: "Safety" },
  { href: "#use-cases", label: "Use cases" },
  { href: "#faq", label: "FAQ" },
];

export function Landing() {
  const [signedIn, setSignedIn] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    document.title = "Kritva: many negotiations at once, none past your limit";
    // A signed-in visitor gets a way back to the console instead of "Sign in".
    const controller = new AbortController();
    fetch("/api/auth/me", { credentials: "same-origin", signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((me: { email?: string | null } | null) => setSignedIn(Boolean(me?.email)))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="lp">
      <a className="lp-skip" href="#main">
        Skip to content
      </a>

      <header className="lp-nav" data-scrolled={scrolled}>
        <div className="lp-container lp-nav-inner">
          <a className="lp-wordmark" href="/" aria-label="Kritva, home">
            Kritva<span className="lp-wordmark-dot" aria-hidden="true" />
          </a>
          <nav className="lp-nav-links" aria-label="Sections">
            {NAV.map((n) => (
              <a key={n.href} className="lp-nav-link" href={n.href}>
                {n.label}
              </a>
            ))}
          </nav>
          <div className="lp-nav-end">
            {signedIn ? (
              <a className="lp-btn lp-btn-ink lp-btn-sm" href={START}>
                Open the console
                <ArrowRightIcon className="lp-btn-arrow" width={14} height={14} />
              </a>
            ) : (
              <a className="lp-btn lp-btn-ink lp-btn-sm" href={SIGN_IN}>
                Sign in
              </a>
            )}
          </div>
        </div>
      </header>

      <main id="main">
        <Hero />
        <Proof />
        <Problem />
        <How />
        <Safety />
        <Compare />
        <Section id="use-cases" eyebrow="05" label="Who it is for" title="One core. A new mandate for each kind of deal." lead="Kritva has no rules for a specific case. Each use case is a mandate that you make in a chat. The checks stay the same.">
          <UseCases />
        </Section>
        <Fit />
        <Faq />
        <FinalCta />
      </main>

      <footer className="lp-footer">
        <div className="lp-container lp-footer-inner">
          <a className="lp-wordmark" href="/" aria-label="Kritva, home">
            Kritva<span className="lp-wordmark-dot" aria-hidden="true" />
          </a>
          <nav className="lp-footer-links" aria-label="Footer">
            {NAV.map((n) => (
              <a key={n.href} href={n.href}>
                {n.label}
              </a>
            ))}
            <a href={SIGN_IN}>Sign in</a>
          </nav>
          <p>A control layer for negotiation. Made in Bangalore.</p>
        </div>
      </footer>
    </div>
  );
}

/* ---------- Building blocks ---------- */

/** Content rises in once as it scrolls into view; with reduced motion it only fades. */
function Reveal({ children, delay = 0, className, as = "div" }: { children: ReactNode; delay?: number; className?: string; as?: "div" | "li" }) {
  const reduced = useReducedMotion();
  const Tag = as === "li" ? motion.li : motion.div;
  return (
    <Tag
      className={className}
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.2 }}
      transition={{ duration: 0.6, ease, delay }}
    >
      {children}
    </Tag>
  );
}

function Eyebrow({ num, children }: { num: string; children: ReactNode }) {
  return (
    <p className="lp-eyebrow">
      <span className="lp-eyebrow-num">{num}</span>
      {children}
    </p>
  );
}

function Section({ id, eyebrow, label, title, lead, soft = false, children }: { id: string; eyebrow: string; label: string; title: string; lead?: string; soft?: boolean; children: ReactNode }) {
  return (
    <section id={id} className={`lp-section${soft ? " lp-section-soft" : ""}`} aria-labelledby={`${id}-title`}>
      <div className="lp-container">
        <Reveal className="lp-section-head">
          <Eyebrow num={eyebrow}>{label}</Eyebrow>
          <h2 id={`${id}-title`} className="lp-h2">
            {title}
          </h2>
          {lead && <p className="lp-lead">{lead}</p>}
        </Reveal>
        {children}
      </div>
    </section>
  );
}

function StartButton({ size = "lg" }: { size?: "lg" | "md" }) {
  return (
    <a className={`lp-btn lp-btn-accent${size === "lg" ? " lp-btn-lg" : ""}`} href={START}>
      Start a test negotiation
      <ArrowRightIcon className="lp-btn-arrow" width={16} height={16} />
    </a>
  );
}

/* ---------- Hero ---------- */

function Hero() {
  const reduced = useReducedMotion();
  // Split and staggered by ~100ms: label, promise, how, actions, then the demo.
  const rise = (i: number) => ({
    initial: reduced ? { opacity: 0 } : { opacity: 0, y: 14, filter: "blur(6px)" },
    animate: { opacity: 1, y: 0, filter: "blur(0px)" },
    transition: { duration: 0.7, ease, delay: 0.08 + i * 0.1 },
  });
  return (
    <section className="lp-hero" aria-labelledby="hero-title">
      <div className="lp-hero-glow" aria-hidden="true" />
      <div className="lp-hero-rings" aria-hidden="true">
        <Rings count={10} step={90} start={140} opacity={0.22} />
      </div>
      <div className="lp-container">
        <div className="lp-hero-copy">
          <motion.p className="lp-chip" {...rise(0)}>
            <span className="lp-live-dot" aria-hidden="true" />
            For procurement, sales desks and brokers
          </motion.p>
          <motion.h1 id="hero-title" className="lp-display" {...rise(1)}>
            Many negotiations at once. <br className="lp-br-wide" />
            None past your limit.
          </motion.h1>
          <motion.p className="lp-lead" {...rise(2)}>
            Kritva talks to each counterparty by chat, voice or phone, in Hindi or English. You set the goal and the limits one time. Code checks every offer before the other side hears it.
          </motion.p>
          <motion.div className="lp-cta-row" {...rise(3)}>
            <StartButton />
            <a className="lp-btn lp-btn-white lp-btn-lg" href="#how">
              See how it works
              <ArrowDownIcon className="lp-btn-arrow" width={16} height={16} />
            </a>
          </motion.div>
          <motion.p className="lp-cta-note" {...rise(4)}>
            <LockIcon width={13} height={13} />
            Sign in with an email link. No password. Your limits stay private.
          </motion.p>
        </div>
        <motion.div className="lp-hero-demo" {...rise(5)}>
          <HeroBoard />
        </motion.div>
      </div>
    </section>
  );
}

/* ---------- Proof ---------- */

const PROOF = [
  { value: "0", label: <><b>Safety failures in 74 live scenarios.</b> The tests run a real model against a simulated counterparty.</> },
  { value: "0 vs 2", label: <><b>Invalid agreements, Kritva against a prompt-only agent.</b> Same model, same 7 scenarios.</> },
  { value: "2", label: <><b>Checks on every move.</b> Gate 1 checks the terms. Gate 2 checks the words.</> },
  { value: "590", label: <><b>About 590 unit and server tests.</b> A replay fails on any changed reply, decision or offer.</> },
];

function Proof() {
  return (
    <section className="lp-proof" aria-label="Evidence">
      <div className="lp-container">
        <ul className="lp-proof-grid">
          {PROOF.map((p, i) => (
            <Reveal key={p.value} as="li" className="lp-stat" delay={i * 0.08}>
              <span className="lp-stat-value">{p.value}</span>
              <span className="lp-stat-label">{p.label}</span>
            </Reveal>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* ---------- Problem ---------- */

const GAPS = [
  { value: "28%", title: "Time", text: "Sales reps sell for only 28% of their week. Each negotiation adds calls and follow-ups.", source: "Salesforce, State of Sales" },
  { value: "~20%", title: "Capacity", text: "Walmart left about 20% of its 100,000+ suppliers on standard terms. Nobody had time to negotiate.", source: "HBR" },
  { value: "8 to 15%", title: "Delegation", text: "A freight broker takes 8 to 15% of the trip cost to negotiate for you.", source: "TruckGuru" },
  { value: "4.9%", title: "Live view of offers", text: "Offers arrive one call at a time. When bids compete, one firm cut its freight cost by 4.9%.", source: "SuperProcure case study" },
];

function Problem() {
  const id = useId();
  const [n, setN] = useState(40);
  const minutes = 45;
  const hours = (n * minutes) / 60;
  const people = hours / 40;
  const pct = ((n - 5) / (400 - 5)) * 100;
  return (
    <Section id="problem" eyebrow="01" label="The problem" title="Each negotiation needs a person. So your time grows with each deal." lead="Today you, your staff or a broker runs each negotiation. A prompt in a chatbot cannot hold your limits across many talks. So nobody can hand this work to an AI safely." soft>
      <div className="lp-problem-grid">
        <Reveal>
          <div className="lp-card lp-formula">
            <p className="lp-formula-eq">
              Your time = <em>N</em> × <em>H</em>
            </p>
            <div className="lp-formula-key">
              <p>
                <b>N</b>the number of negotiations. Your headcount caps it.
              </p>
              <p>
                <b>H</b>your minutes for each one: 30 to 60. We use 45.
              </p>
            </div>
            <div className="lp-slider">
              <div className="lp-slider-top">
                <label htmlFor={id}>Negotiations a week</label>
                <output htmlFor={id} className="lp-tabular">
                  {n}
                </output>
              </div>
              <input id={id} className="lp-range" type="range" min={5} max={400} step={5} value={n} onChange={(e) => setN(Number(e.target.value))} style={{ ["--lp-fill" as string]: `${pct}%` }} aria-valuetext={`${n} negotiations a week`} />
            </div>
            <div className="lp-hours" aria-live="polite">
              <p className="lp-hours-value lp-tabular">
                {hours.toLocaleString("en-IN", { maximumFractionDigits: 1 })} hours a week
              </p>
              <div className="lp-weeks" aria-hidden="true">
                {Array.from({ length: 10 }, (_, i) => {
                  const fill = Math.min(1, Math.max(0, people - i));
                  return (
                    <span key={i} className="lp-week">
                      <span style={{ transform: `scaleX(${fill})` }} />
                    </span>
                  );
                })}
              </div>
              <p className="lp-hours-note">
                That is {people.toLocaleString("en-IN", { maximumFractionDigits: 1 })} {people === 1 ? "person" : "people"} working full time on calls and follow-ups. Each bar is 1 person's 40-hour week.
              </p>
            </div>
          </div>
        </Reveal>
        <Reveal delay={0.1}>
          <ul className="lp-gaps" aria-label="What a person alone misses">
            {GAPS.map((g) => (
              <li key={g.title} className="lp-gap">
                <span className="lp-gap-value">{g.value}</span>
                <span className="lp-gap-text">
                  <b>{g.title}</b>
                  {g.text} <span className="lp-source">Source: {g.source}.</span>
                </span>
              </li>
            ))}
          </ul>
        </Reveal>
      </div>
      <Reveal>
        <div className="lp-sowhat">
          <span className="lp-sowhat-label">So what</span>
          <p>Kritva raises N, not H. Your minutes go to setup and approvals. Kritva does the talking.</p>
        </div>
      </Reveal>
    </Section>
  );
}

/* ---------- How it works ---------- */

function How() {
  return (
    <Section id="how" eyebrow="02" label="How it works" title="You set the mandate one time. Kritva does the talking." lead="A mandate is your goal, your limits and what Kritva may do. You make it in a chat. Kritva then negotiates inside it, with each counterparty.">
      <ol className="lp-steps">
        <Reveal as="li" className="lp-card lp-step">
          <div className="lp-step-copy">
            <span className="lp-step-num">1</span>
            <h3 className="lp-h3">Describe the deal in a chat</h3>
            <p>Write it or paste a picture. Kritva finds the roles and the items. It asks only for missing data. Then you make it live, and this locks the exact version.</p>
          </div>
          <div className="lp-frag" aria-label="Example: a mandate made in a chat">
            <p className="lp-frag-you">Buy 40 ergonomic chairs for our HSR office. Up to ₹7,500 a chair. Delivery by 15 Dec.</p>
            <dl className="lp-mandate">
              <div className="lp-mandate-head">
                <span>40 office chairs</span>
                <span className="lp-pill lp-pill-live">
                  <span className="lp-pill-dot" aria-hidden="true" />
                  Live
                </span>
              </div>
              <div className="lp-mandate-row">
                <dt>
                  Price per chair, maximum <LockIcon width={11} height={11} />
                </dt>
                <dd>₹7,500, no exceptions</dd>
              </div>
              <div className="lp-mandate-row">
                <dt>Advance payment</dt>
                <dd>30%</dd>
              </div>
              <div className="lp-mandate-row">
                <dt>Accept an agreement</dt>
                <dd>Ask me first</dd>
              </div>
              <div className="lp-mandate-row">
                <dt>Share private information</dt>
                <dd>Not allowed</dd>
              </div>
            </dl>
          </div>
        </Reveal>

        <Reveal as="li" className="lp-card lp-step" delay={0.08}>
          <div className="lp-step-copy">
            <span className="lp-step-num">2</span>
            <h3 className="lp-h3">Kritva talks to each counterparty</h3>
            <p>Kritva calls your list, or counterparties call the code in your ad. It runs the talks at the same time. The best offer stops concessions in the others.</p>
          </div>
          <div className="lp-frag" aria-label="Example: channels and languages">
            <div className="lp-channels">
              <span className="lp-channel">
                <ChatIcon width={13} height={13} /> Text chat
              </span>
              <span className="lp-channel">
                <MicIcon width={13} height={13} /> Browser voice
              </span>
              <span className="lp-channel">
                <PhoneIcon width={13} height={13} /> Phone, in and out
              </span>
              <span className="lp-channel">
                <LanguageIcon width={13} height={13} /> Hindi and English
              </span>
            </div>
            <p className="lp-code">
              Listing code for your ad <b className="lp-tabular">9758</b>
            </p>
            <p className="lp-mini-line" lang="hi">
              मैं ₹6,750 दे सकती हूँ।
              <span lang="en">“I can offer ₹6,750.” Kritva on a call, in Hindi.</span>
            </p>
          </div>
        </Reveal>

        <Reveal as="li" className="lp-card lp-step" delay={0.16}>
          <div className="lp-step-copy">
            <span className="lp-step-num">3</span>
            <h3 className="lp-h3">You approve. The deal locks one time.</h3>
            <p>Kritva reads back the exact terms. You approve in the console. The deal is final only when the counterparty says yes again.</p>
          </div>
          <div className="lp-frag" aria-label="Example: an approval">
            <div className="lp-approval">
              <p className="lp-eyebrow">Waiting for you</p>
              <p className="lp-approval-title">Approve ₹7,500 a chair from Sharma Furniture?</p>
              <dl className="lp-kv">
                <div>
                  <dt>Chairs</dt>
                  <dd>40</dd>
                </div>
                <div>
                  <dt>Delivery</dt>
                  <dd>By 15 December</dd>
                </div>
              </dl>
            </div>
            <p className="lp-mini-line">
              A second approval fails.
              <span>The record binds your approval to the exact terms and the mandate version.</span>
            </p>
          </div>
        </Reveal>
      </ol>
      <Reveal>
        <div className="lp-mid-cta">
          <p>
            <b>Try it from the other side.</b>
            A test negotiation puts you in the counterparty's seat. You make offers by chat or voice, and Kritva negotiates against you inside a real mandate.
          </p>
          <StartButton size="md" />
        </div>
      </Reveal>
    </Section>
  );
}

/* ---------- Safety ---------- */

function Safety() {
  return (
    <section id="safety" className="lp-section lp-dark" aria-labelledby="safety-title">
      <div className="lp-dark-glow lp-glow-corner" aria-hidden="true" />
      <div className="lp-dark-rings lp-rings-corner" aria-hidden="true">
        <Rings count={9} step={80} start={120} color="#f0803a" opacity={0.35} />
      </div>
      <div className="lp-container">
        <Reveal className="lp-section-head">
          <Eyebrow num="03">Safety</Eyebrow>
          <h2 id="safety-title" className="lp-h2">
            Code checks each move twice before the other side hears it.
          </h2>
          <p className="lp-lead">Each turn has 7 steps. The model reads and writes. Code does the other 5. Watch Gate 2 stop a draft that tells the counterparty your maximum.</p>
        </Reveal>
        <Reveal>
          <TurnDemo />
        </Reveal>
      </div>
    </section>
  );
}

/* ---------- Comparison ---------- */

type M = "yes" | "trusted" | "price" | "no";
const COLS = ["Changes terms in the talk", "Runs 2+ talks at once", "Shows all live offers", "Keeps your limits private", "Agrees only inside limits", "Commits inside your authority"];
const ROWS_CMP: Array<[string, M[]]> = [
  ["You", ["yes", "no", "no", "yes", "yes", "yes"]],
  ["A broker or agent", ["yes", "no", "no", "trusted", "trusted", "trusted"]],
  ["A price list or auction", ["price", "yes", "yes", "yes", "yes", "yes"]],
  ["A prompt-only AI agent", ["yes", "no", "no", "no", "no", "no"]],
  ["Kritva", ["yes", "yes", "yes", "yes", "yes", "yes"]],
];
const MARK_TEXT: Record<M, string> = { yes: "Yes", trusted: "Only if you trust them", price: "Price only", no: "No" };

function Compare() {
  return (
    <Section id="compare" eyebrow="04" label="Compared" title="A prompt cannot hold your limits. Kritva holds them in code." lead="The model can phrase an offer. Only code can make one." soft>
      <Reveal>
        <div className="lp-compare-wrap" tabIndex={0} role="region" aria-label="Who negotiates for you, and what each option can do">
          <table className="lp-compare">
            <caption className="visually-hidden">Who negotiates for you, and what each option can do</caption>
            <thead>
              <tr>
                <td />
                {COLS.map((c) => (
                  <th key={c} scope="col">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROWS_CMP.map(([who, marks]) => (
                <tr key={who} className={who === "Kritva" ? "lp-compare-kritva" : undefined}>
                  <th scope="row">{who}</th>
                  {marks.map((m, i) => (
                    <td key={COLS[i]}>
                      <Mark kind={m} />
                      <span className="visually-hidden">{MARK_TEXT[m]}</span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="lp-scroll-cue">Scroll the table sideways to see each column.</p>
        <p className="lp-compare-legend" aria-hidden="true">
          <span>
            <Mark kind="yes" /> Yes
          </span>
          <span>
            <Mark kind="trusted" /> Only if you trust them
          </span>
          <span>
            <Mark kind="price" /> Price only
          </span>
          <span>
            <Mark kind="no" /> No
          </span>
        </p>
      </Reveal>
      <Reveal>
        <div className="lp-vs">
          <p className="lp-vs-title">Same model, same 7 test scenarios. Neither side told the counterparty a private limit.</p>
          <span className="lp-vs-num lp-tabular">2</span>
          <p className="lp-vs-text">
            <b>invalid agreements</b> from a prompt-only agent
          </p>
          <span className="lp-vs-num lp-vs-num-good lp-tabular">0</span>
          <p className="lp-vs-text">
            <b>invalid agreements</b> from Kritva
          </p>
        </div>
      </Reveal>
    </Section>
  );
}

/* ---------- Fit ---------- */

const FITS = [
  ["At least 1 term can change", "Not a fixed price or a government fee."],
  ["The counterparty agrees to talk to an AI", "Kritva ends the talk politely if they refuse."],
  ["The deal needs judgment, not a fixed rule", "A sealed-bid tender does not need Kritva."],
  ["2 or more negotiations under 1 mandate", "One renewal with one vendor is faster by hand."],
  ["You can write the limits as rules", "A partnership with open terms needs a person."],
];
const NOT_FITS = [
  ["The relationship is the point", "Your salary talk with your manager. Family property."],
  ["A licensed professional must decide", "A legal settlement. A medical decision."],
  ["There is no valid authority, or the use is unfair", "No consent from you. False offers. Rivals who share 1 agent."],
];

function Fit() {
  return (
    <Section id="fit" eyebrow="06" label="Fit" title="Kritva tells you where it does not fit." lead="Kritva is for many similar talks under clear limits. Where judgment about a person or a profession matters most, a person should lead.">
      <div className="lp-fit">
        <Reveal className="lp-card lp-fit-card lp-fit-dark">
          <h3 className="lp-h3">Kritva runs a negotiation when</h3>
          <ol className="lp-fit-list">
            {FITS.map(([title, note], i) => (
              <li key={title} className="lp-fit-item">
                <span className="lp-fit-n">{i + 1}</span>
                <span>
                  <b>{title}</b>
                  <span className="lp-fit-note">{note}</span>
                </span>
              </li>
            ))}
          </ol>
        </Reveal>
        <Reveal className="lp-card lp-fit-card" delay={0.08}>
          <h3 className="lp-h3">Kritva does not run these</h3>
          <ul className="lp-fit-list">
            {NOT_FITS.map(([title, note]) => (
              <li key={title} className="lp-fit-item">
                <XSmallIcon className="lp-fit-x" width={20} height={20} />
                <span>
                  <b>{title}</b>
                  <span className="lp-fit-note">{note}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="lp-hours-note">Kritva does not research prices, take payments or arrange delivery. It never invents a price or a deadline.</p>
        </Reveal>
      </div>
    </Section>
  );
}

/* ---------- FAQ ---------- */

const FAQ = [
  {
    q: "Will Kritva tell the other side my limit?",
    a: "No. Your limits stay in code. The AI models that read and write the words never see them. Gate 2 also checks each reply and blocks a private amount before anyone hears it.",
  },
  {
    q: "Can Kritva agree to a deal that I did not approve?",
    a: "No. Kritva commits only inside the authority that you gave. When your mandate says “Ask me first”, Kritva stops and asks you. The deal is final only when you approve and the counterparty says yes again. A second approval fails, so a deal locks one time.",
  },
  {
    q: "Does the counterparty know that Kritva is an AI?",
    a: "Kritva says who it acts for. When asked, it says plainly that it is an AI. It never claims to be human or to be you.",
  },
  {
    q: "Which channels and languages does Kritva use?",
    a: "Text chat, voice in the browser and phone calls, in and out. Kritva speaks Hindi and English, and it changes language when the counterparty does.",
  },
  {
    q: "How many negotiations can run at the same time?",
    a: "One mandate runs up to 5 negotiations at the same time, as a default setting. One board shows each offer and its gap to your limit. The best offer stops concessions in the other talks.",
  },
  {
    q: "How do I add a new kind of deal?",
    a: "Describe the deal in a chat, in text or with pictures. Kritva drafts a mandate, and a validator checks it. You select “Make it live”, and this locks the exact version. You do not need new code.",
  },
  {
    q: "How do I sign in?",
    a: "Enter your email. Kritva sends a sign-in link that works one time, for 15 minutes. You do not need a password.",
  },
];

function Faq() {
  return (
    <section id="faq" className="lp-section lp-section-soft" aria-labelledby="faq-title">
      <div className="lp-container lp-faq-grid">
        <Reveal className="lp-section-head">
          <Eyebrow num="07">Questions</Eyebrow>
          <h2 id="faq-title" className="lp-h2">
            Answers before you start.
          </h2>
          <p className="lp-lead">The questions that teams ask first, about control, privacy and fit.</p>
        </Reveal>
        <Reveal className="lp-faq">
          {FAQ.map((f) => (
            <details key={f.q}>
              <summary>
                {f.q}
                <span className="lp-faq-icon" aria-hidden="true">
                  <PlusIcon width={14} height={14} />
                </span>
              </summary>
              <p className="lp-faq-answer">{f.a}</p>
            </details>
          ))}
        </Reveal>
      </div>
    </section>
  );
}

/* ---------- Final call to action ---------- */

function FinalCta() {
  return (
    <section className="lp-section lp-dark lp-final" aria-labelledby="final-title">
      <div className="lp-dark-glow lp-glow-bottom" aria-hidden="true" />
      <div className="lp-dark-rings lp-rings-bottom" aria-hidden="true">
        <Rings count={10} step={80} start={120} color="#f0803a" opacity={0.32} />
      </div>
      <div className="lp-container">
        <Reveal className="lp-final-inner">
          <h2 id="final-title" className="lp-display">
            Put Kritva on your next deal.
          </h2>
          <p className="lp-lead">Set one mandate. Watch each offer on one board. Approve the best one.</p>
          <div className="lp-cta-row">
            <StartButton />
          </div>
          <p className="lp-cta-note">
            <LockIcon width={13} height={13} />
            Sign in with an email link. It works one time, for 15 minutes.
          </p>
        </Reveal>
      </div>
    </section>
  );
}
