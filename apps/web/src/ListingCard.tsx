import { useEffect, useState } from "react";
import { ApiError, api, type ListingView } from "./api.ts";
import { AlertIcon, PhoneIcon } from "./icons.tsx";

interface Props {
  caseId: string;
  calling: boolean;
  onCall: () => void;
}

/**
 * Epic 14: the prepared listing, from the confirmed mandate's public content only. A demo page,
 * clearly not an official marketplace listing. "Call seller" opens a browser voice call with
 * Kritva; no phone number is used.
 */
export function ListingCard({ caseId, calling, onCall }: Props) {
  const [listing, setListing] = useState<ListingView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listing(caseId)
      .then(setListing)
      .catch((e) => setError(e instanceof ApiError ? e.message : "The listing couldn't be loaded."));
  }, [caseId]);

  if (error) {
    return (
      <div className="listing-card">
        <p className="composer-error" role="alert">
          <AlertIcon />
          {error}
        </p>
      </div>
    );
  }
  if (!listing) return <div className="listing-card listing-card-loading" aria-busy="true" />;

  return (
    <article className="listing-card" aria-labelledby="listing-title">
      <p className="listing-badge">Demo listing · not an official marketplace page</p>
      <div className="listing-main">
        <div>
          <h2 id="listing-title" className="listing-title">
            {listing.title}
          </h2>
          <p className="listing-price tabular">{listing.price ?? "Price on request"}</p>
          <p className="listing-location">{listing.location}</p>
        </div>
        <button type="button" className="button button-accent listing-call" onClick={onCall} disabled={calling}>
          {calling ? <span className="spinner" aria-hidden="true" /> : <PhoneIcon />}
          {calling ? "Connecting" : "Call seller"}
        </button>
      </div>
      <ul className="listing listing-details" aria-label="Listing details">
        {listing.terms.map((t) => (
          <li key={t.termId} className="chip">
            <span className="term-name">{`${t.name}: `}</span>
            <span className="tabular">{t.value}</span>
          </li>
        ))}
        {listing.facts.map((f) => (
          <li key={f} className="chip">
            {f}
          </li>
        ))}
      </ul>
      <p className="listing-note">Calling opens a voice conversation in this browser with Kritva, the {listing.sellerRole}'s AI assistant. No phone number is used.</p>
    </article>
  );
}
