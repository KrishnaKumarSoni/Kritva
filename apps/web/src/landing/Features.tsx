/**
 * What Kritva does, shown as small pieces of the product rather than described: one tile per feature.
 * Every tile is a picture of real behaviour (the board, a Hindi call, the private limit, the approval).
 */
import { CheckIcon, LockIcon, MicIcon, PhoneIcon, StarIcon } from "../icons.tsx";
import { BlockIcon, ChatIcon } from "./marks.tsx";

const MAX = 7_500;
const OFFERS: Array<{ name: string; offer: number }> = [
  { name: "Sharma Furniture", offer: 7_500 },
  { name: "Office Hub", offer: 7_700 },
  { name: "SitWell Seating", offer: 7_800 },
];
// The bars run from ₹7,000 to ₹8,500.
const LOW = 7_000;
const HIGH = 8_500;
const share = (n: number) => (n - LOW) / (HIGH - LOW);
const at = (n: number) => `${share(n) * 100}%`;
const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;

export function Features() {
  return (
    <div className="lp-bento">
      <article className="lp-tile lp-tile-wide">
        <div className="lp-tile-visual" aria-hidden="true">
          <div className="lp-gapchart">
            <div className="lp-gapchart-limit" style={{ ["--lp-p" as string]: share(MAX) }}>
              <span>Your maximum {rupees(MAX)}</span>
            </div>
            {OFFERS.map((o, i) => (
              <div key={o.name} className={`lp-gapchart-row${i === 0 ? " lp-gapchart-best" : ""}`}>
                <span className="lp-gapchart-name">
                  {i === 0 && <StarIcon width={12} height={12} />}
                  {o.name}
                </span>
                <span className="lp-gapchart-track">
                  <span className="lp-gapchart-dot" style={{ insetInlineStart: at(o.offer) }} />
                </span>
                <span className="lp-gapchart-amount">{rupees(o.offer)}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="lp-tile-copy">
          <h3 className="lp-tile-title">One board for every offer</h3>
          <p>See each counterparty's latest offer and its gap to your limit. The best offer gets a star, and Kritva stops conceding in the other talks.</p>
        </div>
      </article>

      <article className="lp-tile">
        <div className="lp-tile-visual lp-tile-visual-chat" aria-hidden="true">
          <span className="lp-tb lp-tb-them" lang="hi">
            हम आठ हज़ार में कर देंगे।
          </span>
          <span className="lp-tb lp-tb-kritva" lang="hi">
            ₹8,000 ज़्यादा है। मैं ₹6,750 दे सकती हूँ।
          </span>
          <span className="lp-tb lp-tb-them">Can we do this in English?</span>
          <span className="lp-tb lp-tb-kritva">Sure. I can offer ₹6,750 a chair for all 40.</span>
        </div>
        <div className="lp-tile-copy">
          <h3 className="lp-tile-title">Speaks Hindi and English</h3>
          <p>Kritva starts in Hindi and switches the moment the other side does.</p>
        </div>
      </article>

      <article className="lp-tile">
        <div className="lp-tile-visual lp-tile-visual-call" aria-hidden="true">
          <div className="lp-call">
            <span className="lp-call-avatar">SF</span>
            <span className="lp-call-who">
              <b>Sharma Furniture</b>
              <span>Kritva is on the call</span>
            </span>
            <span className="lp-wave">
              {Array.from({ length: 5 }, (_, i) => (
                <span key={i} />
              ))}
            </span>
          </div>
          <div className="lp-channel-row">
            <span>
              <PhoneIcon width={13} height={13} /> Phone
            </span>
            <span>
              <ChatIcon width={13} height={13} /> Chat link
            </span>
            <span>
              <MicIcon width={13} height={13} /> Browser voice
            </span>
          </div>
        </div>
        <div className="lp-tile-copy">
          <h3 className="lp-tile-title">Calls out, takes calls in</h3>
          <p>Kritva calls your list, or counterparties call the code in your ad. Chat and browser voice work too.</p>
        </div>
      </article>

      <article className="lp-tile">
        <div className="lp-tile-visual lp-tile-visual-lock" aria-hidden="true">
          <div className="lp-vault">
            <LockIcon width={16} height={16} />
            <span>
              <b>{rupees(MAX)}</b> Your maximum, only you see it
            </span>
          </div>
          <div className="lp-blocked">
            <s>“Our maximum is {rupees(MAX)}.”</s>
            <span className="lp-blocked-chip">
              <BlockIcon width={12} height={12} /> Blocked before sending
            </span>
          </div>
        </div>
        <div className="lp-tile-copy">
          <h3 className="lp-tile-title">Your limits stay private</h3>
          <p>The AI model never sees your limits. A reply that would reveal one never leaves.</p>
        </div>
      </article>

      <article className="lp-tile">
        <div className="lp-tile-visual" aria-hidden="true">
          <ol className="lp-steps-mini">
            <li>
              <CheckIcon width={13} height={13} /> Kritva reads back the terms
            </li>
            <li className="lp-steps-mini-you">
              <CheckIcon width={13} height={13} /> You approve ₹7,500 a chair
            </li>
            <li>
              <CheckIcon width={13} height={13} /> They say yes again
            </li>
            <li className="lp-steps-mini-done">
              <LockIcon width={13} height={13} /> Deal locked, one time
            </li>
          </ol>
        </div>
        <div className="lp-tile-copy">
          <h3 className="lp-tile-title">Nothing is final without you</h3>
          <p>Kritva asks before it commits. A second approval fails, so a deal locks one time.</p>
        </div>
      </article>
    </div>
  );
}
