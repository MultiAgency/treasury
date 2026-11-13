import { ArrowUpRight, Check, LockSimple, ShieldCheck, Snowflake, Wallet } from "@phosphor-icons/react";
import { motion, useInView, useMotionValueEvent, useScroll, useTransform, type MotionValue } from "motion/react";
import { Suspense, useEffect, useRef, useState, type ElementType, type ReactNode, type RefObject } from "react";
import { BorderBeam } from "@/components/ui/border-beam";
import { MagicCard } from "@/components/ui/magic-card";
import { Marquee } from "@/components/ui/marquee";
import { TextReveal } from "@/components/ui/text-reveal";
import { Logo } from "../brand";
import { ConnectWallet } from "./connect";
import { SceneBoundary, VaultScene } from "./scene";
import { scrollToSection } from "./scroll";

/**
 * The landing's scroll story, after the hero (#194): what it runs on, the product, how it works, security, the FAQ and
 * the final call. Every claim is something the app's pages do, and no figure is invented: the charts carry none. With
 * `reduced` motion nothing autoplays or follows the scroll, and each piece is drawn as it ends.
 */

const EASE = [0.16, 1, 0.3, 1] as const;

/** A block that rises out of a blur as it scrolls into view; with reduced motion, it's simply there. */
const reveal = (reduced: boolean, blur = 8, duration = 0.9) => reduced ? {} : {
  initial: { opacity: 0, y: 40, filter: `blur(${blur}px)` },
  whileInView: { opacity: 1, y: 0, filter: "blur(0px)" },
  viewport: { once: true, margin: "-8% 0px" },
  transition: { duration, ease: EASE },
};

const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789#%&*+=<>/";
const randomGlyph = () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)]!;

/**
 * A heading that decodes out of scrambled characters, left to right, when it scrolls into view. Its name is the text
 * itself, read once from a visually hidden copy; the scramble is decoration. With reduced motion, it's the text.
 */
function Scramble({ text, as: Tag = "h2", className, duration = 1300, reduced }: { text: string; as?: ElementType; className?: string; duration?: number; reduced: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const inView = useInView(ref, { once: true, margin: "0px 0px -20% 0px" });
  const [shown, setShown] = useState(() => reduced ? text : text.replace(/\S/g, randomGlyph));
  useEffect(() => {
    if (!inView || reduced) return;
    const start = performance.now();
    // Each character settles at its own moment, mostly left to right.
    const settle = [...text].map((_, i) => (i / text.length) * 0.75 + Math.random() * 0.25);
    let frame = 0;
    let last = 0;
    const tick = (now: number) => {
      const progress = Math.min((now - start) / duration, 1);
      if (now - last > 45 || progress === 1) {
        last = now;
        setShown([...text].map((char, i) => char === " " || progress >= settle[i]! ? char : randomGlyph()).join(""));
      }
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [inView, text, duration, reduced]);
  // The final text, invisible, holds the heading's size; the scrambling text sits over it, so nothing reflows as it decodes.
  return <Tag ref={ref} className={className}>
    <span className="sr-only">{text}</span>
    <span aria-hidden="true" className="relative block">
      <span className="invisible">{text}</span>
      <span className="absolute inset-0">{shown}</span>
    </span>
  </Tag>;
}

function Label({ index, children }: { index: number; children: string }) {
  return <p className="lp-label"><span className="text-white/80">{String(index).padStart(2, "0")}/05</span> {children}</p>;
}

/* ---------- 1. What it runs on ---------- */

function RunsOn() {
  // What the app is built on and works with: NEAR accounts and wallets, MultiAgency's agents, and a DAO's own votes.
  const marks = ["NEAR", "MultiAgency", "Sputnik DAO"];
  return <section aria-label="Runs on" className="relative border-y border-white/[0.06] py-8">
    <div className="lp-container flex flex-col items-center gap-6 md:flex-row md:gap-10">
      <p className="shrink-0 font-mono text-[11.5px] tracking-[0.08em] text-white/60">Runs on</p>
      <div className="lp-marquee-mask w-full min-w-0">
        <p className="sr-only">{marks.join(", ")}</p>
        <Marquee aria-hidden="true" className="[--duration:28s] [--gap:3.5rem]" repeat={4}>
          {[...marks, ...marks].map((mark, i) => <span key={i} className="flex items-center gap-14">
            <span className="lp-wordmark">{mark}</span>
            <span className="size-1.5 rotate-45 bg-[#f5d68f]/50" />
          </span>)}
        </Marquee>
      </div>
    </div>
  </section>;
}

/* ---------- 2. Manifesto ---------- */

function Manifesto({ reduced }: { reduced: boolean }) {
  return <section id="product" data-lp-section="2" aria-label="Product" className="relative">
    <div aria-hidden="true" className="pointer-events-none absolute left-1/2 top-[30%] h-[60vh] w-[70vw] -translate-x-1/2 rounded-full bg-[#927827]/[0.12] blur-[120px]" />
    <TextReveal
      className="h-[240vh]"
      heading={<div className="flex flex-col gap-5">
        <Label index={2}>Product</Label>
        <Scramble reduced={reduced} text="An agent that keeps to your word." className="lp-h2 max-w-3xl" />
      </div>}
      textClassName="font-heading text-[clamp(1.55rem,3.1vw,3rem)] font-medium leading-[1.18] tracking-[-0.03em]"
    >
      You set the allocation targets. You sign the daily, weekly and monthly budgets in USD and the caps for each asset. On the schedule you choose, the agent rebalances inside those limits, and every change to the policy waits for your wallet.
    </TextReveal>
  </section>;
}

/* ---------- 3. How it works ---------- */

const ASSETS = [
  { name: "wNEAR", now: 0.78, target: 0.56 },
  { name: "USDC", now: 0.34, target: 0.52 },
  { name: "ETH", now: 0.5, target: 0.4 },
];

/** Now against target for each asset, illustrated: the bars drift, then the scheduled run brings them back. Still, they rest on target. */
function AllocationChart({ reduced }: { reduced: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { margin: "-10% 0px" });
  const [settled, setSettled] = useState(reduced);
  useEffect(() => {
    if (!inView || reduced) return;
    const timer = setInterval(() => setSettled(value => !value), 2600);
    return () => clearInterval(timer);
  }, [inView, reduced]);
  const shown = reduced || inView;
  return <div ref={ref} aria-hidden="true" className="relative mt-8 flex min-h-[230px] flex-1 items-end gap-6 px-1 pt-10 sm:gap-10">
    {[0.25, 0.5, 0.75].map(line => <span key={line} className="absolute inset-x-0 border-t border-dashed border-white/[0.06]" style={{ bottom: `${line * 100}%` }} />)}
    {ASSETS.map((asset, i) => <div key={asset.name} className="relative flex h-full flex-1 flex-col justify-end gap-3">
      <div className="relative flex h-full items-end justify-center gap-2.5">
        <motion.div
          className="w-[38%] max-w-12 rounded-t-[10px] border border-white/15 bg-white/[0.05]"
          initial={reduced ? false : { height: 0 }}
          animate={{ height: shown ? `${(settled ? asset.target : asset.now) * 100}%` : 0 }}
          transition={{ duration: 1.4, ease: EASE, delay: i * 0.08 }}
        />
        <motion.div
          className="relative w-[38%] max-w-12 rounded-t-[10px]"
          style={{ background: "linear-gradient(to top, rgb(146 120 39 / 0.15), rgb(255 233 138 / 0.85) 85%, #fff)", boxShadow: "0 0 30px -2px rgb(245 214 143 / 0.55), inset 0 1px 0 #fff" }}
          initial={reduced ? false : { height: 0 }}
          animate={{ height: shown ? `${asset.target * 100}%` : 0 }}
          transition={{ duration: 1.6, ease: EASE, delay: 0.2 + i * 0.1 }}
        />
      </div>
      <p className="text-center font-mono text-[11px] tracking-wide text-white/65">{asset.name}</p>
    </div>)}
    <div className="absolute right-0 top-0 flex gap-4 font-mono text-[10.5px] text-white/60">
      <span className="flex items-center gap-1.5"><i className="size-2 rounded-[3px] border border-white/30 bg-white/5" />Now</span>
      <span className="flex items-center gap-1.5"><i className="size-2 rounded-[3px] bg-[#ffe6b3] shadow-[0_0_8px_#ffe6b3]" />Target</span>
    </div>
  </div>;
}

/** Daily, weekly and monthly budgets as rings, the way a signed policy bounds spending. Illustrative: no amounts. */
function BudgetRings({ reduced }: { reduced: boolean }) {
  const ref = useRef<SVGSVGElement>(null);
  const inView = useInView(ref, { once: true, margin: "-10% 0px" });
  const rings = [
    { label: "Daily", r: 74, fill: 0.62 },
    { label: "Weekly", r: 58, fill: 0.44 },
    { label: "Monthly", r: 42, fill: 0.28 },
  ];
  return <div className="mt-auto flex items-center gap-6 pt-6">
    <svg ref={ref} aria-hidden="true" viewBox="0 0 180 180" className="size-[170px] shrink-0 -rotate-90 overflow-visible">
      <defs>
        <linearGradient id="lp-ring" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#ffffff" /><stop offset="1" stopColor="#f5d68f" /></linearGradient>
        <filter id="lp-ring-glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="3" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
      </defs>
      {rings.map((ring, i) => <g key={ring.label}>
        <circle cx="90" cy="90" r={ring.r} fill="none" stroke="rgb(255 255 255 / 0.07)" strokeWidth="9" />
        <motion.circle cx="90" cy="90" r={ring.r} fill="none" stroke="url(#lp-ring)" strokeWidth="9" strokeLinecap="round" filter="url(#lp-ring-glow)"
          initial={reduced ? false : { pathLength: 0 }} animate={{ pathLength: reduced || inView ? ring.fill : 0 }} transition={{ duration: 1.8, delay: 0.2 + i * 0.18, ease: EASE }} />
      </g>)}
    </svg>
    <ul className="flex flex-col gap-3">
      {rings.map((ring, i) => <li key={ring.label} className="flex items-center gap-2.5">
        <span aria-hidden="true" className="size-2 rounded-full bg-white" style={{ opacity: 1 - i * 0.25, boxShadow: "0 0 8px #ffe6b3" }} />
        <span className="flex flex-col"><span className="text-[13.5px] text-white/90">{ring.label}</span><span className="font-mono text-[10.5px] text-white/60">Budget in USD</span></span>
      </li>)}
    </ul>
  </div>;
}

/** Shielding, drawn: a public balance moved into the confidential one. */
function GlassCube() {
  return <div className="mt-auto flex items-center justify-between gap-4 pt-8">
    <div className="flex flex-col gap-2 font-mono text-[10.5px]">
      <span className="rounded-full border border-white/10 px-2.5 py-1 text-white/65">Public balance</span>
      <span className="lp-shimmer-arrow pl-3 text-white/60" aria-hidden="true">↓ shield</span>
      <span className="rounded-full border border-[#ffe6b3]/40 bg-[#ffe6b3]/[0.06] px-2.5 py-1 text-[#fff7d6] shadow-[0_0_16px_-4px_#ffe6b3]">Confidential balance</span>
    </div>
    <div className="lp-cube-scene mr-2" aria-hidden="true">
      <div className="lp-cube"><span /><span /><span /><span /><span /><span /><b /></div>
    </div>
  </div>;
}

/** A drifting value kept inside the target band by scheduled runs. Still, the dot rests in the band. */
function RebalanceBand({ reduced }: { reduced: boolean }) {
  const path = "M0 70 C 40 70, 60 40, 95 30 S 120 70, 140 70 C 175 70, 190 100, 225 112 S 255 72, 280 70 C 320 70, 335 46, 365 36 S 395 68, 420 70";
  return <div className="relative mt-auto pt-6">
    <svg viewBox="0 0 420 140" className="h-[150px] w-full overflow-visible" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="lp-band" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#f5d68f" stopOpacity="0.02" /><stop offset="0.5" stopColor="#f5d68f" stopOpacity="0.16" /><stop offset="1" stopColor="#f5d68f" stopOpacity="0.02" /></linearGradient>
        <linearGradient id="lp-trail" x1="0" x2="1"><stop offset="0" stopColor="#fff" stopOpacity="0.1" /><stop offset="1" stopColor="#fff7d6" /></linearGradient>
      </defs>
      <rect x="0" y="48" width="420" height="44" fill="url(#lp-band)" />
      <line x1="0" x2="420" y1="48" y2="48" stroke="rgb(245 214 143 / 0.4)" strokeDasharray="3 5" />
      <line x1="0" x2="420" y1="92" y2="92" stroke="rgb(245 214 143 / 0.4)" strokeDasharray="3 5" />
      {[105, 245, 385].map((x, i) => <g key={x}>
        <line x1={x} x2={x} y1="8" y2="132" stroke="rgb(255 255 255 / 0.12)" />
        <circle cx={x} cy="8" r="3" fill="#fff7d6">{!reduced && <animate attributeName="opacity" values="0.3;1;0.3" dur="2.4s" begin={`${i * 0.8}s`} repeatCount="indefinite" />}</circle>
      </g>)}
      <path d={path} fill="none" stroke="url(#lp-trail)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {reduced
        ? <circle cx="420" cy="70" r="5" fill="#fff" style={{ filter: "drop-shadow(0 0 6px #ffe6b3)" }} />
        : <circle r="5" fill="#fff" style={{ filter: "drop-shadow(0 0 6px #ffe6b3)" }}><animateMotion dur="7s" repeatCount="indefinite" path={path} /></circle>}
    </svg>
    <div aria-hidden="true" className="mt-2 flex justify-between font-mono text-[10.5px] text-white/60"><span>Target band</span><span>Scheduled runs</span></div>
  </div>;
}

/** A policy change waiting for the owner's wallet, then approved. Still, it shows the approval. */
function WalletApproval({ reduced }: { reduced: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { margin: "-10% 0px" });
  const [step, setStep] = useState(reduced ? 2 : 0);
  useEffect(() => {
    if (!inView || reduced) return;
    const timer = setInterval(() => setStep(value => (value + 1) % 3), 1700);
    return () => clearInterval(timer);
  }, [inView, reduced]);
  return <div ref={ref} aria-hidden="true" className="mt-auto pt-6">
    <div className="rounded-2xl border border-white/10 bg-black/40 p-4 shadow-[inset_0_1px_0_rgb(255_255_255/0.05)]">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-[13px] text-white/90"><Wallet size={15} /> Policy change</span>
        <span className="font-mono text-[10.5px] text-white/60">NEAR wallet</span>
      </div>
      <ul className="mt-3 flex flex-col gap-1.5 font-mono text-[11px] text-white/65">
        <li className="flex justify-between"><span>Weekly budget, USD</span><span className="text-white/85">Changed</span></li>
        <li className="flex justify-between"><span>Cap for ETH</span><span className="text-white/85">Changed</span></li>
      </ul>
      <motion.div
        className="mt-4 flex h-10 items-center justify-center gap-2 rounded-full text-[13px] font-medium"
        initial={false}
        animate={step === 2
          ? { backgroundColor: "rgba(255,233,138,0.12)", color: "#fff7d6", boxShadow: "0 0 0 1px rgba(255,233,138,0.45), 0 0 26px -6px #ffe6b3" }
          : { backgroundColor: "#ffffff", color: "#050506", boxShadow: step === 1 ? "0 0 0 4px rgba(255,255,255,0.18), 0 0 30px -4px #ffe6b3" : "0 0 0 0px rgba(255,255,255,0)" }}
        transition={{ duration: reduced ? 0 : 0.5 }}
      >
        {step === 2 ? <><Check size={15} weight="bold" /> Approved by the owner</> : step === 1 ? "Signing…" : "Approve in wallet"}
      </motion.div>
    </div>
  </div>;
}

function Tile({ title, body, children, className = "", reduced }: { title: string; body: string; children: ReactNode; className?: string; reduced: boolean }) {
  return <motion.article className={`lp-tile ${className}`} {...reveal(reduced)}>
    <div className="lp-tile-glass">
      <div className="lp-tile-inner"><h3>{title}</h3><p>{body}</p>{children}</div>
    </div>
  </motion.article>;
}

function HowItWorks({ reduced }: { reduced: boolean }) {
  return <section id="how" data-lp-section="3" aria-label="How it works" className="relative py-28 sm:py-36">
    <div aria-hidden="true" className="pointer-events-none absolute right-[-10%] top-[10%] h-[50vh] w-[50vw] rounded-full bg-[#f5d68f]/[0.07] blur-[120px]" />
    <div className="lp-container relative">
      <div className="mb-14 flex flex-col gap-5 md:mb-20 md:flex-row md:items-end md:justify-between">
        <div className="flex flex-col gap-5">
          <Label index={3}>How it works</Label>
          <Scramble reduced={reduced} text="Five controls. One owner." className="lp-h2 max-w-2xl" />
        </div>
        <p className="max-w-sm text-[15px] leading-relaxed text-white/65">The agent runs the treasury. You decide what it may do, and every rule it follows carries your signature, or your DAO's vote.</p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-12">
        <motion.article className="lp-tile md:col-span-7 md:row-span-2" {...reveal(reduced)}>
          <MagicCard className="h-full rounded-[26px]" gradientSize={320} gradientColor="rgba(245,214,143,0.12)" gradientFrom="#ffe6b3" gradientTo="#927827">
            <div className="lp-tile-inner min-h-[460px]">
              <span className="mb-4 w-fit rounded-full border border-white/10 px-2.5 py-1 font-mono text-[10.5px] text-white/65">wNEAR · USDC · ETH</span>
              <h3>Allocation targets</h3>
              <p>Choose the share each asset should hold. When the book drifts from your targets, ask for a rebalance to approve, or let autopilot swap it back on its schedule, within your limits.</p>
              <AllocationChart reduced={reduced} />
            </div>
          </MagicCard>
          <BorderBeam size={220} duration={9} colorFrom="#ffffff" colorTo="#f5d68f" borderWidth={1.5} />
        </motion.article>
        <Tile reduced={reduced} className="md:col-span-5" title="Signed spending limits" body="Daily, weekly and monthly budgets in USD, plus caps for each asset. You sign them, and the platform checks every operation against them.">
          <BudgetRings reduced={reduced} />
        </Tile>
        <Tile reduced={reduced} className="md:col-span-5" title="Confidential balances" body="Shield the agent's public balances into its confidential balance, held privately for your Treasury.">
          <GlassCube />
        </Tile>
        <Tile reduced={reduced} className="md:col-span-6" title="Scheduled rebalancing" body="Autopilot runs on the interval you set, with a ceiling in USD for each run, and brings drift back to target. You turn it on, and you can turn it off.">
          <RebalanceBand reduced={reduced} />
        </Tile>
        <Tile reduced={reduced} className="md:col-span-6" title="Owner stays in control" body="Policy changes and the agent's proposals wait for your wallet, or your DAO's vote. Until then, the agent keeps to the policy you signed last.">
          <WalletApproval reduced={reduced} />
        </Tile>
      </div>
    </div>
  </section>;
}

/* ---------- 4. Security ---------- */

const POINTS = [
  { title: "Signed limits", body: "The agent works inside the daily, weekly and monthly budgets and the per-asset caps that you signed.", icon: ShieldCheck, at: 0.14, place: "left-[4%] top-[26%] xl:left-[8%]" },
  { title: "Owner approval", body: "A policy change, a grant or a proposal's swaps go ahead only once you approve them in your NEAR wallet, or your DAO votes for them.", icon: Wallet, at: 0.4, place: "right-[4%] top-[40%] xl:right-[8%]" },
  { title: "An emergency stop", body: "Freeze the agent from any of its pages, and it refuses every send until you unfreeze it.", icon: Snowflake, at: 0.66, place: "left-[7%] bottom-[12%] xl:left-[13%]" },
];

function PointCard({ point, index }: { point: (typeof POINTS)[number]; index: number }) {
  const Icon = point.icon;
  return <div className="lp-point-card">
    <div className="mb-3 flex items-center justify-between">
      <span aria-hidden="true" className="grid size-9 place-items-center rounded-full border border-[#ffe6b3]/30 bg-[#ffe6b3]/[0.06] text-[#fff7d6] shadow-[0_0_20px_-6px_#ffe6b3]"><Icon size={17} /></span>
      <span aria-hidden="true" className="lp-point-index">0{index + 1}</span>
    </div>
    <h3>{point.title}</h3>
    <p>{point.body}</p>
  </div>;
}

function Point({ point, index, progress }: { point: (typeof POINTS)[number]; index: number; progress: MotionValue<number> }) {
  const opacity = useTransform(progress, [point.at, point.at + 0.1], [0, 1]);
  const y = useTransform(progress, [point.at, point.at + 0.1], [30, 0]);
  const blur = useTransform(progress, [point.at, point.at + 0.1], ["blur(10px)", "blur(0px)"]);
  return <motion.div className={`lp-point hidden md:block ${point.place}`} style={{ opacity, y, filter: blur }}>
    <PointCard point={point} index={index} />
  </motion.div>;
}

/** On narrow screens the points take turns in one slot under the vault; screen readers get all three at once. */
function MobilePoints({ progress }: { progress: MotionValue<number> }) {
  const [current, setCurrent] = useState(0);
  useMotionValueEvent(progress, "change", value => {
    const index = POINTS.reduce((found, point, i) => (value >= point.at ? i : found), 0);
    setCurrent(index);
  });
  const point = POINTS[current]!;
  const Icon = point.icon;
  return <div aria-hidden="true" className="absolute inset-x-4 bottom-[9%] md:hidden">
    <motion.div key={current} className="lp-point-card" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
      <div className="mb-2 flex items-center gap-3">
        <span className="grid size-8 place-items-center rounded-full border border-[#ffe6b3]/30 text-[#fff7d6]"><Icon size={15} /></span>
        <span className="lp-point-index">0{current + 1}/03</span>
      </div>
      <h3>{point.title}</h3>
      <p>{point.body}</p>
    </motion.div>
  </div>;
}

/** The vault behind the security story: still, without motion; the CSS glow without WebGL. */
function SecurityVault({ webgl, reduced, turn }: { webgl: boolean; reduced: boolean; turn?: RefObject<number> }) {
  const glow = <div className="lp-fallback" aria-hidden="true"><span style={{ top: "52%" }} /></div>;
  if (!webgl) return glow;
  return <>{glow}<SceneBoundary><Suspense fallback={null}>
    <VaultScene className="absolute inset-0" lift={-0.15} progress={turn} floor={false} still={reduced} />
  </Suspense></SceneBoundary></>;
}

function SecurityHeading({ reduced }: { reduced: boolean }) {
  return <div className="flex flex-col items-center gap-4 px-4 text-center">
    <Label index={4}>Security</Label>
    <Scramble reduced={reduced} text="Limits you sign. Approval you give." className="lp-h2 max-w-3xl !text-[clamp(1.9rem,3.6vw,3.6rem)]" />
  </div>;
}

/** With reduced motion, nothing turns with the scroll: the three points stand around (or under) a still vault. */
function StillSecurity({ webgl }: { webgl: boolean }) {
  return <section id="security" data-lp-section="4" aria-label="Security" className="relative overflow-hidden py-28 md:h-svh md:min-h-[720px] md:py-0">
    {/* On a phone the vault keeps one screen's height under the heading, and the points follow it. */}
    <div className="absolute inset-x-0 top-0 h-svh md:inset-0 md:h-auto"><SecurityVault webgl={webgl} reduced /></div>
    <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-[22%] bg-gradient-to-b from-[#050506] to-transparent" />
    <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-[22%] bg-gradient-to-t from-[#050506] to-transparent" />
    <div className="relative z-10 md:absolute md:inset-x-0 md:top-[11%]"><SecurityHeading reduced /></div>
    {POINTS.map((point, i) => <div key={point.title} className={`lp-point hidden md:block ${point.place}`}><PointCard point={point} index={i} /></div>)}
    <ul className="relative z-10 mt-[52svh] flex flex-col gap-3 px-4 md:hidden">
      {POINTS.map((point, i) => <li key={point.title}><PointCard point={point} index={i} /></li>)}
    </ul>
  </section>;
}

function Security({ webgl }: { webgl: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end end"] });
  const turn = useRef(0);
  useMotionValueEvent(scrollYProgress, "change", value => { turn.current = value; });
  return <section ref={ref} id="security" data-lp-section="4" aria-label="Security" className="relative h-[320vh]">
    <div className="sticky top-0 h-svh overflow-hidden">
      <SecurityVault webgl={webgl} reduced={false} turn={turn} />
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-[22%] bg-gradient-to-b from-[#050506] to-transparent" />
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-[22%] bg-gradient-to-t from-[#050506] to-transparent" />
      <div className="absolute inset-x-0 top-[9%] z-10 sm:top-[11%]"><SecurityHeading reduced={false} /></div>
      {POINTS.map((point, i) => <Point key={point.title} point={point} index={i} progress={scrollYProgress} />)}
      <MobilePoints progress={scrollYProgress} />
      {/* The points, for a screen reader on a phone, where only one is shown at a time. */}
      <ul className="sr-only md:hidden">{POINTS.map(point => <li key={point.title}>{point.title}: {point.body}</li>)}</ul>
    </div>
  </section>;
}

/* ---------- 5. FAQ, the final call and the footer ---------- */

const FAQ = [
  { q: "What does signing in do?", a: "Your NEAR wallet signs a message addressed to this server, so it knows the account is yours. It moves nothing." },
  { q: "Who sets the limits?", a: "You do. You sign daily, weekly and monthly budgets in USD and caps for each asset, and the agent works inside them. For a Treasury a DAO owns, the DAO votes on them." },
  { q: "Does the agent rebalance on its own?", a: "Only on autopilot, under a grant you authorize for the saved strategy. It runs on the interval you set, swaps toward your allocation targets up to the ceiling you set for each run, and stays inside your signed policy. Otherwise, the agent's proposals wait for your approval." },
  { q: "What is a confidential balance?", a: "Shielding moves the agent's public balances into a confidential balance, held privately for your Treasury rather than shown in public." },
  { q: "Can I stop it?", a: "Yes. You can turn autopilot off at any time, and the emergency stop freezes the agent, which then refuses every send until it's unfrozen." },
  { q: "Can a DAO own a Treasury?", a: "Yes. A member signs in with their own account, and the DAO's own votes connect the agent, approve its proposals and change its policy." },
];

function Faq({ reduced }: { reduced: boolean }) {
  return <section id="faq" data-lp-section="5" aria-label="FAQ" className="relative py-28 sm:py-36">
    <div className="lp-container grid gap-12 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <div className="flex flex-col gap-5">
        <Label index={5}>FAQ</Label>
        <Scramble reduced={reduced} text="Questions, answered plainly." className="lp-h2" />
      </div>
      <div className="lp-faq">
        {FAQ.map((item, i) => <details key={item.q} open={i === 0}>
          <summary>{item.q}<i aria-hidden="true" /></summary>
          <p>{item.a}</p>
        </details>)}
      </div>
    </div>
  </section>;
}

function FinalCall({ reduced }: { reduced: boolean }) {
  return <section aria-label="Connect" className="relative overflow-hidden py-36 sm:py-48">
    <div className="lp-final-glow" aria-hidden="true" />
    {[360, 560, 780, 1020].map((size, i) => <span key={size} className="lp-final-ring" style={{ width: size, height: size, opacity: 1 - i * 0.2 }} aria-hidden="true" />)}
    <motion.div className="lp-container relative flex flex-col items-center gap-7 text-center" {...reveal(reduced, 10, 1.1)}>
      <Logo className="size-14 drop-shadow-[0_0_24px_rgba(255,233,138,0.5)]" bars={22} />
      <h2 className="lp-h2 !text-[clamp(2.6rem,6.4vw,6.6rem)]">Set the limits.<br /><span className="lp-fade-word">Let it run.</span></h2>
      <p className="max-w-md text-[16px] leading-relaxed text-white/70">Sign-in signs a message. It moves nothing.</p>
      <ConnectWallet containerClassName="lp-signin" className="lp-btn lp-btn-lg" />
      <p className="max-w-md text-[12.5px] leading-relaxed text-white/60">Connect your NEAR wallet to open your treasuries, set one up for your account, or open a DAO's.</p>
    </motion.div>
  </section>;
}

export function Footer() {
  const links = [["Product", "product"], ["How it works", "how"], ["Security", "security"], ["FAQ", "faq"]] as const;
  return <footer className="lp-footer border-t border-white/[0.06] py-12">
    <div className="lp-container flex flex-col gap-8 md:flex-row md:items-center md:justify-between">
      <div className="flex items-center gap-3">
        <Logo className="size-8" />
        <div className="flex flex-col">
          <span className="font-heading text-sm font-semibold tracking-tight">Agentic Treasury</span>
          <span className="text-[12.5px] text-white/60">Runs on NEAR, with MultiAgency's agents.</span>
        </div>
      </div>
      <nav aria-label="Footer">
        <ul className="flex flex-wrap gap-x-6 gap-y-2 text-[13px] text-white/65">
          {links.map(([label, id]) => <li key={id}><a href={`#${id}`} className="inline-flex items-center gap-1 transition-colors hover:text-white" onClick={event => { event.preventDefault(); scrollToSection(id); }}>{label}<ArrowUpRight size={11} aria-hidden="true" /></a></li>)}
        </ul>
      </nav>
      <p className="text-[12.5px] text-white/60">Sign-in signs a message. It moves nothing.</p>
    </div>
  </footer>;
}

export function LandingSections({ reduced, webgl }: { reduced: boolean; webgl: boolean }) {
  return <>
    <RunsOn />
    <Manifesto reduced={reduced} />
    <HowItWorks reduced={reduced} />
    {reduced ? <StillSecurity webgl={webgl} /> : <Security webgl={webgl} />}
    <Faq reduced={reduced} />
    <FinalCall reduced={reduced} />
  </>;
}
