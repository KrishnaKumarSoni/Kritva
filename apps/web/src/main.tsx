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

// A page cached from before a deploy asks for chunks the deploy removed: reload once to get the new ones.
window.addEventListener("vite:preloadError", (event) => {
  try {
    if (sessionStorage.getItem("kritva-chunk-reload")) return;
    sessionStorage.setItem("kritva-chunk-reload", "1");
  } catch {
    return;
  }
  event.preventDefault();
  window.location.reload();
});
window.addEventListener("load", () => {
  try {
    window.setTimeout(() => sessionStorage.removeItem("kritva-chunk-reload"), 10_000);
  } catch {
    /* storage unavailable: nothing to clear */
  }
});

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
