/**
 * Kritva's landing page, at "/". Every other address is the console (App.tsx), so sign-in works as it
 * always did: "Sign in" opens /signin and "Start a test negotiation" opens /negotiations, where the
 * curtain carries the email-link and passkey forms. An email without access can request it there.
 *
 * Show, not tell: the hero runs a live deal board, the features are small pieces of the product, and the
 * safety section runs one reply through the checks.
 */
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";
import { ArrowRightIcon, LockIcon, MicIcon, PhoneIcon, PlusIcon, ShieldIcon } from "../icons.tsx";
import { Features } from "./Features.tsx";
import { GateDemo } from "./GateDemo.tsx";
import { HeroBoard } from "./HeroBoard.tsx";
import { UseCases } from "./UseCases.tsx";
import { ArrowDownIcon, ChatIcon, LanguageIcon, Rings } from "./marks.tsx";
import "./landing.css";

const START = "/negotiations";
const SIGN_IN = "/signin";
const ease = [0.2, 0, 0, 1] as const;

const NAV = [
  { href: "#how", label: "How it works" },
  { href: "#features", label: "Features" },
  { href: "#safety", label: "Safety" },
  { href: "#use-cases", label: "Use cases" },
  { href: "#faq", label: "FAQ" },
];

export function Landing() {
  const [signedIn, setSignedIn] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    document.title = "Kritva: many negotiations at once, none past your limit";
    // One visit counted for the admin page: a count per day, no cookie, nothing that identifies the visitor.
    try {
      navigator.sendBeacon?.("/api/views", new Blob([JSON.stringify({ path: "/" })], { type: "application/json" }));
    } catch {
      /* counting is optional */
    }
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
        <WorksWith />

        <Section id="how" label="How it works" title="Set it up once. Kritva does the talking." lead="Tell Kritva the deal and your limits in a chat. It negotiates with every counterparty, and you approve the deal.">
          <HowSteps />
        </Section>

        <Section id="features" label="Features" title="A negotiator for every counterparty, at the same time." soft>
          <Reveal>
            <Features />
          </Reveal>
        </Section>

        <Safety />

        <Section id="use-cases" label="Use cases" title="Built for teams that negotiate all day." lead="Procurement, sales desks, freight brokers and platforms use the same core. Each new kind of deal is a new mandate, not new code.">
          <UseCases />
        </Section>

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
          <p>Made in Bangalore.</p>
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

function Section({ id, label, title, lead, soft = false, children }: { id: string; label: string; title: string; lead?: string; soft?: boolean; children: ReactNode }) {
  return (
    <section id={id} className={`lp-section${soft ? " lp-section-soft" : ""}`} aria-labelledby={`${id}-title`}>
      <div className="lp-container">
        <Reveal className="lp-section-head">
          <p className="lp-label">{label}</p>
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

function AccessNote() {
  return (
    <p className="lp-cta-note">
      <LockIcon width={13} height={13} />
      Sign in with an email link. No access yet? Request it in one step.
    </p>
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
          <motion.div {...rise(4)}>
            <AccessNote />
          </motion.div>
        </div>
        <motion.div className="lp-hero-demo" {...rise(5)}>
          <HeroBoard />
        </motion.div>
      </div>
    </section>
  );
}

/** Where Kritva talks, in one quiet line under the hero. */
function WorksWith() {
  const items = [
    { icon: <PhoneIcon width={16} height={16} />, label: "Phone calls, in and out" },
    { icon: <ChatIcon width={16} height={16} />, label: "Text chat link" },
    { icon: <MicIcon width={16} height={16} />, label: "Voice in the browser" },
    { icon: <LanguageIcon width={16} height={16} />, label: "Hindi and English" },
    { icon: <ShieldIcon width={16} height={16} />, label: "You approve every deal" },
  ];
  return (
    <section className="lp-works" aria-label="Where Kritva negotiates">
      <div className="lp-container">
        <ul className="lp-works-list">
          {items.map((it) => (
            <li key={it.label}>
              {it.icon}
              {it.label}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* ---------- How it works ---------- */

function HowSteps() {
  return (
    <>
      <ol className="lp-steps">
        <Reveal as="li" className="lp-card lp-step">
          <div className="lp-step-copy">
            <span className="lp-step-num">1</span>
            <h3 className="lp-h3">Describe the deal</h3>
            <p>Write it in a chat, or paste a picture. Kritva drafts the mandate and asks only for what is missing.</p>
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
            </dl>
          </div>
        </Reveal>

        <Reveal as="li" className="lp-card lp-step" delay={0.08}>
          <div className="lp-step-copy">
            <span className="lp-step-num">2</span>
            <h3 className="lp-h3">Kritva talks to everyone</h3>
            <p>Kritva calls your list, or counterparties call the code in your ad. All the talks run at the same time.</p>
          </div>
          <div className="lp-frag" aria-label="Example: a listing code and a line from a call">
            <p className="lp-code">
              Listing code for your ad <b className="lp-tabular">9758</b>
            </p>
            <p className="lp-mini-line" lang="hi">
              मैं ₹6,750 दे सकती हूँ।
              <span lang="en">“I can offer ₹6,750.” Kritva on a call, in Hindi.</span>
            </p>
            <p className="lp-mini-line">
              4 vendors on one board
              <span>The best offer stops concessions in the other talks.</span>
            </p>
          </div>
        </Reveal>

        <Reveal as="li" className="lp-card lp-step" delay={0.16}>
          <div className="lp-step-copy">
            <span className="lp-step-num">3</span>
            <h3 className="lp-h3">You approve the deal</h3>
            <p>Kritva reads back the exact terms and asks you. The deal is final only when the counterparty says yes again.</p>
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
          </div>
        </Reveal>
      </ol>
      <Reveal>
        <div className="lp-mid-cta">
          <p>
            <b>Try it from the other side.</b>
            A test negotiation puts you in the counterparty's seat. You make offers by chat or voice, and Kritva negotiates against you.
          </p>
          <StartButton size="md" />
        </div>
      </Reveal>
    </>
  );
}

/* ---------- Safety ---------- */

function Safety() {
  const points = [
    { title: "The model never sees your limits.", text: "Code decides each offer. The AI model only writes the words." },
    { title: "Every reply is checked twice.", text: "The terms gate checks the offer. The words gate blocks leaks, invented facts and false agreement." },
    { title: "Every step is on the record.", text: "Your approval binds to the exact terms. A second approval fails." },
  ];
  return (
    <section id="safety" className="lp-section lp-dark" aria-labelledby="safety-title">
      <div className="lp-dark-glow lp-glow-corner" aria-hidden="true" />
      <div className="lp-dark-rings lp-rings-corner" aria-hidden="true">
        <Rings count={9} step={80} start={120} color="#f0803a" opacity={0.35} />
      </div>
      <div className="lp-container lp-safety">
        <Reveal className="lp-safety-copy">
          <p className="lp-label lp-label-dark">Safety</p>
          <h2 id="safety-title" className="lp-h2">
            Your limit stays yours.
          </h2>
          <p className="lp-lead">An AI that only follows a prompt can agree to terms you never approved. Kritva puts code between the model and the counterparty.</p>
          <ul className="lp-points">
            {points.map((p) => (
              <li key={p.title}>
                <ShieldIcon width={18} height={18} />
                <span>
                  <b>{p.title}</b> {p.text}
                </span>
              </li>
            ))}
          </ul>
        </Reveal>
        <Reveal delay={0.1}>
          <GateDemo />
        </Reveal>
      </div>
    </section>
  );
}

/* ---------- FAQ ---------- */

const FAQ = [
  {
    q: "Will Kritva tell the other side my limit?",
    a: "No. Your limits stay in code. The AI models that read and write the words never see them, and the words gate blocks a private amount before anyone hears it.",
  },
  {
    q: "Can Kritva agree to a deal that I did not approve?",
    a: "No. When your mandate says “Ask me first”, Kritva stops and asks you. The deal is final only when you approve and the counterparty says yes again.",
  },
  {
    q: "Why not give a chatbot a prompt?",
    a: "A prompt cannot hold your limits across many talks, and the model can agree to anything. In Kritva, code decides each offer and checks each reply. The model only phrases what code allows.",
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
    q: "When is Kritva not a good fit?",
    a: "When the relationship is the point, such as a salary talk with your manager. When a licensed professional must decide. When no term can change, such as a fixed fee.",
  },
  {
    q: "How do I get access?",
    a: "Kritva is open to invited teams for now. Enter your email on the sign-in page. If it has no access yet, you can request it there in one step, and we reply by email.",
  },
];

function Faq() {
  return (
    <section id="faq" className="lp-section lp-section-soft" aria-labelledby="faq-title">
      <div className="lp-container lp-faq-grid">
        <Reveal className="lp-section-head">
          <p className="lp-label">FAQ</p>
          <h2 id="faq-title" className="lp-h2">
            Questions, answered.
          </h2>
          <p className="lp-lead">About control, privacy and fit.</p>
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
          <p className="lp-lead">Set one mandate. Watch every offer on one board. Approve the best one.</p>
          <div className="lp-cta-row">
            <StartButton />
          </div>
          <AccessNote />
        </Reveal>
      </div>
    </section>
  );
}
