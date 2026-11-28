import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

/**
 * "/" is the landing page. Every other address is the console, and so are the counterparty's page
 * (/?view=buyer#session=...) and older console links that name a negotiation in the hash (/#session=...).
 * Each loads only its own code.
 */
const params = new URLSearchParams(window.location.search);
const isLanding = window.location.pathname === "/" && !params.has("view") && !/(?:^|[#&])session=/.test(window.location.hash);

// Two separate imports, not one ternary: the bundler then preloads each page's own CSS and code.
const Landing = lazy(() => import("./landing/Landing.tsx").then((m) => ({ default: m.Landing })));
const Console = lazy(() => import("./App.tsx").then((m) => ({ default: m.App })));
const Root = isLanding ? Landing : Console;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Root />
    </Suspense>
  </StrictMode>,
);
