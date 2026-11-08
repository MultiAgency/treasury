import { ArrowDown, ArrowRight } from "@phosphor-icons/react";
import { Suspense, useCallback, useEffect, useState, type CSSProperties } from "react";
import { Logo } from "../brand";
import { Circuit } from "./circuit";
import { ConnectWallet } from "./connect";
import { Intro } from "./intro";
import { hasWebGL, loadScene, SceneBoundary, VaultScene } from "./scene";
import { prefersReducedMotion, scrollToSection } from "./scroll";
import { Footer, LandingSections } from "./sections";
// The landing's own styles, imported by the landing alone: nothing shared reads them.
import "./landing.css";

const NAV = [
  { label: "Product", target: "product" },
  { label: "How it works", target: "how" },
  { label: "Security", target: "security" },
  { label: "FAQ", target: "faq" },
] as const;

/** Where the vault's centre sits, as a share of the hero's height (matches the scene's lift). */
const VAULT_Y = { wide: 0.4, narrow: 0.364 };

/** The section in view, for the "01/05 Scroll" counter, and whether the page has scrolled past the hero. */
function useScrollState() {
  const [state, setState] = useState({ index: 1, pastHero: false });
  useEffect(() => {
    const update = () => {
      const middle = window.innerHeight * 0.5;
      let index = 1;
      document.querySelectorAll<HTMLElement>("[data-lp-section]").forEach(section => {
        if (section.getBoundingClientRect().top <= middle) index = Number(section.dataset.lpSection);
      });
      const pastHero = window.scrollY > window.innerHeight * 0.75;
      setState(previous => previous.index === index && previous.pastHero === pastHero ? previous : { index, pastHero });
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);
  return state;
}

function useWide() {
  const [wide, setWide] = useState(() => window.innerWidth >= 768);
  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= 768);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return wide;
}

/** Loading stages of the vault, as the intro's progress target; 100 once frames are on screen or WebGL is out. */
function useVaultLoad(webgl: boolean) {
  const [target, setTarget] = useState(12);
  const raise = useCallback((value: number) => setTarget(current => Math.max(current, value)), []);
  useEffect(() => {
    if (!webgl) { raise(100); return; }
    raise(28);
    void loadScene().then(() => raise(64), () => raise(100));
    // A slow device still gets its page: the intro gives way after this, and the vault fades in when it can.
    const timer = setTimeout(() => raise(100), 6000);
    return () => clearTimeout(timer);
  }, [raise, webgl]);
  const onStage = useCallback((stage: "created" | "ready") => raise(stage === "created" ? 86 : 100), [raise]);
  return { target, onStage, fail: useCallback(() => raise(100), [raise]) };
}

/**
 * The root signed out (#194): what Agentic Treasury is, and signing in. Full-bleed, outside the app's sidebar shell, with
 * its own nav on the hero. Every Connect wallet is the app's own sign-in (`connect.tsx`). Nothing of an account's is read.
 *
 * The hero's text is never held invisible: while the vault loads, the intro (decorative, hidden from assistive
 * technology) covers it and fades away, and the text only rises out of a blur. With reduced motion there's no intro,
 * nothing autoplays or follows the scroll, and the vault is one still frame (or, without WebGL, the CSS glow).
 */
export default function Landing() {
  const [reduced] = useState(prefersReducedMotion);
  const [webgl] = useState(hasWebGL);
  const wide = useWide();
  const { index: section, pastHero } = useScrollState();
  const load = useVaultLoad(webgl);
  const [ready, setReady] = useState(reduced);
  const [introGone, setIntroGone] = useState(reduced);
  const finishIntro = useCallback(() => {
    setReady(true);
    setTimeout(() => setIntroGone(true), 1100);
  }, []);
  return <div className={`landing${ready ? " is-ready" : ""}`} style={{ "--lp-vault-y": `${(wide ? VAULT_Y.wide : VAULT_Y.narrow) * 100}%` } as CSSProperties}>
    <header className={`lp-nav${pastHero ? " is-scrolled" : ""}`}>
      <a href="#top" className="flex items-center gap-2.5 justify-self-start rounded-md" onClick={event => { event.preventDefault(); scrollToSection("top"); }}>
        <Logo className="size-8" />
        <span className="whitespace-nowrap font-heading text-[14px] font-semibold tracking-tight text-white">Agentic Treasury</span>
      </a>
      <nav aria-label="Landing" className="hidden justify-self-center lg:block">
        <ul className="flex items-center gap-1">
          {NAV.map(item => <li key={item.target}>
            <a href={`#${item.target}`} className="lp-nav-link" onClick={event => { event.preventDefault(); scrollToSection(item.target); }}>{item.label}</a>
          </li>)}
        </ul>
      </nav>
      <ConnectWallet containerClassName="lp-signin-nav" className="lp-btn lp-btn-sm" />
    </header>

    <main id="main" tabIndex={-1}>
      <section id="top" aria-labelledby="lp-title" className="lp-hero" data-lp-section="1">
        <div className="lp-fallback" aria-hidden="true"><span /></div>
        {webgl && <SceneBoundary onError={load.fail}>
          <Suspense fallback={null}>
            <VaultScene className="absolute inset-0" lift={wide ? 0.5 : 0.9} onStage={load.onStage} still={reduced} />
          </Suspense>
        </SceneBoundary>}
        <div className="lp-hero-fade" aria-hidden="true" />
        <div className="lp-hero-board hidden lg:block"><Circuit cyRatio={VAULT_Y.wide} /></div>
        <div className="lp-streaks" aria-hidden="true">{Array.from({ length: 7 }, (_, i) => <i key={i} />)}</div>

        <div className="lp-hero-copy">
          <h1 id="lp-title" className="lp-h1 lp-rise" style={{ animationDelay: "250ms" }}>
            Your treasury. <span className="lp-fade-word">Your limits.</span>
          </h1>
          <p className="lp-sub lp-rise" style={{ animationDelay: "400ms" }}>Set targets, sign limits, rebalance on autopilot.</p>
          <div className="lp-get-started lp-rise" style={{ animationDelay: "550ms" }}>
            <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
              <ConnectWallet containerClassName="lp-signin" className="lp-btn" />
              <button type="button" className="lp-ghost" onClick={() => scrollToSection("how")}>
                See how it works <ArrowRight size={15} aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>

        <div className="lp-hero-foot lp-rise" style={{ animationDelay: "900ms" }} aria-hidden="true">
          <span className="hidden sm:inline">Owner-signed policy</span>
          <span className="lp-hero-foot-bar"><i /></span>
        </div>
        {!introGone && <Intro target={load.target} onDone={finishIntro} />}
      </section>

      <LandingSections reduced={reduced} webgl={webgl} />
    </main>

    <Footer />

    {/* Its name is what it shows, "01/05 Scroll", finished for a screen reader: "… to the next section". */}
    <button type="button" className="lp-scroll" onClick={() => scrollToSection(["product", "how", "security", "faq", "top"][section - 1] ?? "top")}>
      <span className="lp-scroll-icon" aria-hidden="true"><ArrowDown size={13} className={section === 5 ? "rotate-180" : undefined} /></span>
      <span className="font-mono text-[11px] tracking-wider text-white/75">{String(section).padStart(2, "0")}/05</span>
      <span className="text-[11px] text-white/60">{section === 5 ? "Back to top" : <>Scroll<span className="sr-only"> to the next section</span></>}</span>
    </button>
  </div>;
}
