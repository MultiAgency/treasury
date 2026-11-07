import { ArrowDown, ArrowRight } from "@phosphor-icons/react";
import { Component, lazy, Suspense, useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Logo } from "./brand";
import { Circuit } from "./landing/circuit";
import { Intro } from "./landing/intro";
import { scrollToSection } from "./landing/scroll";
import { SignIn } from "./session";
import "./landing/landing.css";

// The 3D vault and the scroll story load on their own, after the hero: the signed-in dashboard never downloads them.
const loadScene = () => import("./landing/vault-scene");
const VaultScene = lazy(loadScene);
const LandingSections = lazy(() => import("./landing/sections"));

const NAV = [
  { label: "Product", target: "product" },
  { label: "How it works", target: "how" },
  { label: "Security", target: "security" },
  { label: "FAQ", target: "faq" },
] as const;

/** Where the vault's centre sits, as a share of the hero's height (matches the scene's lift). */
const VAULT_Y = { wide: 0.4, narrow: 0.364 };

function hasWebGL() {
  try {
    return Boolean(document.createElement("canvas").getContext("webgl2"));
  } catch {
    return false;
  }
}

/** If the 3D vault fails, the page keeps its CSS glow and the intro still finishes. */
class SceneBoundary extends Component<{ children: ReactNode; onError: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onError(); }
  render() { return this.state.failed ? null : this.props.children; }
}

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
function useVaultLoad() {
  const [target, setTarget] = useState(12);
  const raise = useCallback((value: number) => setTarget(current => Math.max(current, value)), []);
  useEffect(() => {
    if (!hasWebGL()) { raise(100); return; }
    raise(28);
    void loadScene().then(() => raise(64), () => raise(100));
    // A slow device still gets its page: the intro gives way after this, and the vault fades in when it can.
    const timer = setTimeout(() => raise(100), 6000);
    return () => clearTimeout(timer);
  }, [raise]);
  const onStage = useCallback((stage: "created" | "ready") => raise(stage === "created" ? 86 : 100), [raise]);
  return { target, onStage, fail: useCallback(() => raise(100), [raise]) };
}

/** Signed out: what this is and how to sign in. No balances, records or operation requests. */
export function SignedOutHome({ selfService = false }: { selfService?: boolean }) {
  const wide = useWide();
  const { index: section, pastHero } = useScrollState();
  const load = useVaultLoad();
  const [ready, setReady] = useState(false);
  const [introGone, setIntroGone] = useState(false);
  const finishIntro = useCallback(() => {
    setReady(true);
    setTimeout(() => setIntroGone(true), 1100);
  }, []);
  return <main id="treasury-main" className={`landing${ready ? " is-ready" : ""}`} style={{ "--lp-vault-y": `${(wide ? VAULT_Y.wide : VAULT_Y.narrow) * 100}%` } as CSSProperties}>
    <header className={`lp-nav${pastHero ? " is-scrolled" : ""}`}>
      <a href="#top" className="flex items-center gap-2.5 justify-self-start" onClick={event => { event.preventDefault(); window.scrollTo({ top: 0, behavior: "smooth" }); }}>
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
      <SignIn containerClassName="lp-signin-nav" className="lp-btn lp-btn-sm" />
    </header>

    <section id="top" className="lp-hero" data-lp-section="1">
      <div className="lp-fallback" aria-hidden="true"><span /></div>
      <SceneBoundary onError={load.fail}>
        <Suspense fallback={null}>
          <VaultScene className="absolute inset-0" lift={wide ? 0.5 : 0.9} onStage={load.onStage} />
        </Suspense>
      </SceneBoundary>
      <div className="lp-hero-fade" aria-hidden="true" />
      <div className="lp-hero-board hidden lg:block"><Circuit cyRatio={VAULT_Y.wide} /></div>
      <div className="lp-streaks" aria-hidden="true">{Array.from({ length: 7 }, (_, i) => <i key={i} />)}</div>

      <div className="lp-hero-copy">
        <h1 className="lp-h1 lp-rise" style={{ animationDelay: "250ms" }}>
          Your treasury. <span className="lp-fade-word">Your limits.</span>
        </h1>
        <p className="lp-sub lp-rise" style={{ animationDelay: "400ms" }}>Set targets, sign limits, rebalance on autopilot.</p>
        <section aria-label="Get started" className="lp-get-started lp-rise" style={{ animationDelay: "550ms" }}>
          <div className="flex flex-col items-center gap-3 sm:flex-row">
            <SignIn primary containerClassName="lp-signin" className="lp-btn" />
            <button type="button" className="lp-ghost" onClick={() => scrollToSection("how")}>
              See how it works <ArrowRight size={15} aria-hidden="true" />
            </button>
          </div>
        </section>
      </div>

      <div className="lp-hero-foot lp-rise" style={{ animationDelay: "900ms" }} aria-hidden="true">
        <span className="hidden sm:inline">Owner-approved policy</span>
        <span className="lp-hero-foot-bar"><i /></span>
      </div>
      {!introGone && <Intro target={load.target} onDone={finishIntro} />}
    </section>

    <button type="button" className="lp-scroll" onClick={() => scrollToSection(["product", "how", "security", "faq", "top"][section - 1] ?? "top")} aria-label="Scroll to the next section">
      <span className="lp-scroll-icon"><ArrowDown size={13} aria-hidden="true" /></span>
      <span className="font-mono text-[11px] tracking-wider text-white/70">{String(section).padStart(2, "0")}/05</span>
      <span className="text-[11px] text-white/45">{section === 5 ? "Back to top" : "Scroll"}</span>
    </button>

    <Suspense fallback={null}>
      <LandingSections selfService={selfService} />
    </Suspense>
  </main>;
}
