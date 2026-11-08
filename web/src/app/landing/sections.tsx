import { ArrowUpRight, Check, LockSimple, ShieldCheck, Wallet } from "@phosphor-icons/react";
import { motion, useInView, useMotionValueEvent, useScroll, useTransform, type MotionValue } from "motion/react";
import { lazy, Suspense, useEffect, useRef, useState, type ElementType, type ReactNode } from "react";
import { BorderBeam } from "@/components/ui/border-beam";
import { MagicCard } from "@/components/ui/magic-card";
import { Marquee } from "@/components/ui/marquee";
import { TextReveal } from "@/components/ui/text-reveal";
import { Logo } from "../brand";
import { SignIn } from "../session";
import { scrollToSection } from "./scroll";

const VaultScene = lazy(() => import("./vault-scene"));

const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789#%&*+=<>/";
const randomGlyph = () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)]!;

/** A heading that decodes out of scrambled characters, left to right, when it scrolls into view. */
function Scramble({ text, as: Tag = "h2", className, duration = 1300 }: { text: string; as?: ElementType; className?: string; duration?: number }) {
  const ref = useRef<HTMLElement>(null);
  const inView = useInView(ref, { once: true, margin: "0px 0px -20% 0px" });
  const [shown, setShown] = useState(() => text.replace(/\S/g, randomGlyph));
  useEffect(() => {
    if (!inView) return;
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
  }, [inView, text, duration]);
  // The final text, invisible, holds the heading's size; the scrambling text sits over it, so nothing reflows as it decodes.
  return <Tag ref={ref} className={className} aria-label={text}>
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
  const marks = ["NEAR", "NEAR Intents", "MultiAgency"];
  return <section aria-label="Runs on" className="relative border-y border-white/[0.06] py-8">
    <div className="lp-container flex flex-col items-center gap-6 md:flex-row md:gap-10">
      <p className="shrink-0 font-mono text-[11.5px] tracking-[0.08em] text-white/45">Runs on</p>
      <div className="lp-marquee-mask w-full min-w-0">
        <Marquee className="[--duration:28s] [--gap:3.5rem]" repeat={4}>
          {[...marks, ...marks].map((mark, i) => <span key={i} className="flex items-center gap-14">
            <span className="lp-wordmark">{mark}</span>
            <span aria-hidden="true" className="size-1.5 rotate-45 bg-[#a9c4b7]/50" />
          </span>)}
        </Marquee>
      </div>
    </div>
  </section>;
}

/* ---------- 2. Manifesto ---------- */

function Manifesto() {
  return <section id="product" data-lp-section="2" aria-label="Product" className="relative">
    <div aria-hidden="true" className="pointer-events-none absolute left-1/2 top-[30%] h-[60vh] w-[70vw] -translate-x-1/2 rounded-full bg-[#5e7f72]/[0.12] blur-[120px]" />
    <TextReveal
      className="h-[240vh]"
      heading={<div className="flex flex-col gap-5">
        <Label index={2}>Product</Label>
        <Scramble text="An agent that keeps to your word." className="lp-h2 max-w-3xl" />
      </div>}
      textClassName="font-heading text-[clamp(1.55rem,3.1vw,3rem)] font-medium leading-[1.18] tracking-[-0.03em]"
    >
      You set the allocation targets. You sign the daily, weekly and monthly budgets in USD and a cap for each asset. On the schedule you choose, the agent rebalances inside those limits, and every change to the policy waits for your wallet.
    </TextReveal>
  </section>;
}

/* ---------- 3. How it works ---------- */

const ASSETS = [
  { name: "wNEAR", now: 0.78, target: 0.56 },
  { name: "USDC", now: 0.34, target: 0.52 },
  { name: "ETH", now: 0.5, target: 0.4 },
];

/** Now against target for each asset: the bars drift, then the scheduled run brings them back. */
function AllocationChart() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { margin: "-10% 0px" });
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!inView) return;
    const timer = setInterval(() => setSettled(value => !value), 2600);
    return () => clearInterval(timer);
  }, [inView]);
  return <div ref={ref} className="relative mt-8 flex min-h-[230px] flex-1 items-end gap-6 px-1 pt-10 sm:gap-10">
    {[0.25, 0.5, 0.75].map(line => <span key={line} aria-hidden="true" className="absolute inset-x-0 border-t border-dashed border-white/[0.06]" style={{ bottom: `${line * 100}%` }} />)}
    {ASSETS.map((asset, i) => <div key={asset.name} className="relative flex h-full flex-1 flex-col justify-end gap-3">
      <div className="relative flex h-full items-end justify-center gap-2.5">
        <motion.div
          className="w-[38%] max-w-12 rounded-t-[10px] border border-white/15 bg-white/[0.05]"
          initial={{ height: 0 }}
          animate={{ height: inView ? `${(settled ? asset.target : asset.now) * 100}%` : 0 }}
          transition={{ duration: 1.4, ease: [0.16, 1, 0.3, 1], delay: i * 0.08 }}
        />
        <motion.div
          className="relative w-[38%] max-w-12 rounded-t-[10px]"
          style={{ background: "linear-gradient(to top, rgb(94 127 114 / 0.15), rgb(201 255 233 / 0.85) 85%, #fff)", boxShadow: "0 0 30px -2px rgb(169 196 183 / 0.55), inset 0 1px 0 #fff" }}
          initial={{ height: 0 }}
          animate={{ height: inView ? `${asset.target * 100}%` : 0 }}
          transition={{ duration: 1.6, ease: [0.16, 1, 0.3, 1], delay: 0.2 + i * 0.1 }}
        />
      </div>
      <p className="text-center font-mono text-[11px] tracking-wide text-white/60">{asset.name}</p>
    </div>)}
    <div className="absolute right-0 top-0 flex gap-4 font-mono text-[10.5px] text-white/50">
      <span className="flex items-center gap-1.5"><i className="size-2 rounded-[3px] border border-white/30 bg-white/5" />Now</span>
      <span className="flex items-center gap-1.5"><i className="size-2 rounded-[3px] bg-[#c9ffe9] shadow-[0_0_8px_#c9ffe9]" />Target</span>
    </div>
  </div>;
}

/** Daily, weekly and monthly budgets as rings, the way a signed policy bounds spending. */
function BudgetRings() {
  const ref = useRef<SVGSVGElement>(null);
  const inView = useInView(ref, { once: true, margin: "-10% 0px" });
  const rings = [
    { label: "Daily", r: 74, fill: 0.62 },
    { label: "Weekly", r: 58, fill: 0.44 },
    { label: "Monthly", r: 42, fill: 0.28 },
  ];
  return <div className="mt-auto flex items-center gap-6 pt-6">
    <svg ref={ref} viewBox="0 0 180 180" className="size-[170px] shrink-0 -rotate-90 overflow-visible">
      <defs>
        <linearGradient id="lp-ring" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#ffffff" /><stop offset="1" stopColor="#7fb39c" /></linearGradient>
        <filter id="lp-ring-glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="3" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
      </defs>
      {rings.map((ring, i) => <g key={ring.label}>
        <circle cx="90" cy="90" r={ring.r} fill="none" stroke="rgb(255 255 255 / 0.07)" strokeWidth="9" />
        <motion.circle cx="90" cy="90" r={ring.r} fill="none" stroke="url(#lp-ring)" strokeWidth="9" strokeLinecap="round" filter="url(#lp-ring-glow)"
          initial={{ pathLength: 0 }} animate={{ pathLength: inView ? ring.fill : 0 }} transition={{ duration: 1.8, delay: 0.2 + i * 0.18, ease: [0.16, 1, 0.3, 1] }} />
      </g>)}
    </svg>
    <ul className="flex flex-col gap-3">
      {rings.map((ring, i) => <li key={ring.label} className="flex items-center gap-2.5">
        <span className="size-2 rounded-full bg-white" style={{ opacity: 1 - i * 0.25, boxShadow: "0 0 8px #c9ffe9" }} />
        <span className="flex flex-col"><span className="text-[13.5px] text-white/90">{ring.label}</span><span className="font-mono text-[10.5px] text-white/45">Budget in USD</span></span>
      </li>)}
    </ul>
  </div>;
}

function GlassCube() {
  return <div className="mt-auto flex items-center justify-between gap-4 pt-8">
    <div className="flex flex-col gap-2 font-mono text-[10.5px]">
      <span className="rounded-full border border-white/10 px-2.5 py-1 text-white/45">Public balance</span>
      <span className="lp-shimmer-arrow pl-3 text-white/35" aria-hidden="true">↓ shield</span>
      <span className="rounded-full border border-[#c9ffe9]/40 bg-[#c9ffe9]/[0.06] px-2.5 py-1 text-[#e6fff4] shadow-[0_0_16px_-4px_#c9ffe9]">Confidential balance</span>
    </div>
    <div className="lp-cube-scene mr-2" aria-hidden="true">
      <div className="lp-cube"><span /><span /><span /><span /><span /><span /><b /></div>
    </div>
  </div>;
}

/** A drifting value kept inside the target band by scheduled runs. */
function RebalanceBand() {
  const path = "M0 70 C 40 70, 60 40, 95 30 S 120 70, 140 70 C 175 70, 190 100, 225 112 S 255 72, 280 70 C 320 70, 335 46, 365 36 S 395 68, 420 70";
  return <div className="relative mt-auto pt-6">
    <svg viewBox="0 0 420 140" className="h-[150px] w-full overflow-visible" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="lp-band" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#a9c4b7" stopOpacity="0.02" /><stop offset="0.5" stopColor="#a9c4b7" stopOpacity="0.16" /><stop offset="1" stopColor="#a9c4b7" stopOpacity="0.02" /></linearGradient>
        <linearGradient id="lp-trail" x1="0" x2="1"><stop offset="0" stopColor="#fff" stopOpacity="0.1" /><stop offset="1" stopColor="#e6fff4" /></linearGradient>
      </defs>
      <rect x="0" y="48" width="420" height="44" fill="url(#lp-band)" />
      <line x1="0" x2="420" y1="48" y2="48" stroke="rgb(169 196 183 / 0.4)" strokeDasharray="3 5" />
      <line x1="0" x2="420" y1="92" y2="92" stroke="rgb(169 196 183 / 0.4)" strokeDasharray="3 5" />
      {[105, 245, 385].map((x, i) => <g key={x}>
        <line x1={x} x2={x} y1="8" y2="132" stroke="rgb(255 255 255 / 0.12)" />
        <circle cx={x} cy="8" r="3" fill="#e6fff4"><animate attributeName="opacity" values="0.3;1;0.3" dur="2.4s" begin={`${i * 0.8}s`} repeatCount="indefinite" /></circle>
      </g>)}
      <path d={path} fill="none" stroke="url(#lp-trail)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <circle r="5" fill="#fff" style={{ filter: "drop-shadow(0 0 6px #c9ffe9)" }}>
        <animateMotion dur="7s" repeatCount="indefinite" path={path} />
      </circle>
    </svg>
    <div className="mt-2 flex justify-between font-mono text-[10.5px] text-white/45"><span>Target band</span><span>Scheduled runs</span></div>
  </div>;
}

/** A policy change waiting for the owner's wallet, then approved. */
function WalletApproval() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { margin: "-10% 0px" });
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!inView) return;
    const timer = setInterval(() => setStep(value => (value + 1) % 3), 1700);
    return () => clearInterval(timer);
  }, [inView]);
  return <div ref={ref} className="mt-auto pt-6">
    <div className="rounded-2xl border border-white/10 bg-black/40 p-4 shadow-[inset_0_1px_0_rgb(255_255_255/0.05)]">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-[13px] text-white/90"><Wallet size={15} aria-hidden="true" /> Policy change</span>
        <span className="font-mono text-[10.5px] text-white/40">NEAR wallet</span>
      </div>
      <ul className="mt-3 flex flex-col gap-1.5 font-mono text-[11px] text-white/55">
        <li className="flex justify-between"><span>Weekly budget, USD</span><span className="text-white/80">Changed</span></li>
        <li className="flex justify-between"><span>Cap for ETH</span><span className="text-white/80">Changed</span></li>
      </ul>
      <motion.div
        className="mt-4 flex h-10 items-center justify-center gap-2 rounded-full text-[13px] font-medium"
        animate={step === 2
          ? { backgroundColor: "rgba(201,255,233,0.12)", color: "#e6fff4", boxShadow: "0 0 0 1px rgba(201,255,233,0.45), 0 0 26px -6px #c9ffe9" }
          : { backgroundColor: "#ffffff", color: "#050506", boxShadow: step === 1 ? "0 0 0 4px rgba(255,255,255,0.18), 0 0 30px -4px #c9ffe9" : "0 0 0 0px rgba(255,255,255,0)" }}
        transition={{ duration: 0.5 }}
      >
        {step === 2 ? <><Check size={15} weight="bold" aria-hidden="true" /> Approved by the owner</> : step === 1 ? "Signing…" : "Approve in wallet"}
      </motion.div>
    </div>
  </div>;
}

function Tile({ title, body, children, className = "" }: { title: string; body: string; children: ReactNode; className?: string }) {
  return <motion.article
    className={`lp-tile ${className}`}
    initial={{ opacity: 0, y: 40, filter: "blur(8px)" }}
    whileInView={{ opacity: 1, y: 0, filter: "blur(0px)" }}
    viewport={{ once: true, margin: "-8% 0px" }}
    transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
  >
    <div className="lp-tile-glass">
      <div className="lp-tile-inner"><h3>{title}</h3><p>{body}</p>{children}</div>
    </div>
  </motion.article>;
}

function HowItWorks() {
  return <section id="how" data-lp-section="3" aria-label="How it works" className="relative py-28 sm:py-36">
    <div aria-hidden="true" className="pointer-events-none absolute right-[-10%] top-[10%] h-[50vh] w-[50vw] rounded-full bg-[#a9c4b7]/[0.07] blur-[120px]" />
    <div className="lp-container relative">
      <div className="mb-14 flex flex-col gap-5 md:mb-20 md:flex-row md:items-end md:justify-between">
        <div className="flex flex-col gap-5">
          <Label index={3}>How it works</Label>
          <Scramble text="Five controls. One owner." className="lp-h2 max-w-2xl" />
        </div>
        <p className="max-w-sm text-[15px] leading-relaxed text-white/55">The agent runs the treasury. You decide what it may do, and every rule it follows carries your signature.</p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-12">
        <motion.article
          className="lp-tile md:col-span-7 md:row-span-2"
          initial={{ opacity: 0, y: 40, filter: "blur(8px)" }}
          whileInView={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          viewport={{ once: true, margin: "-8% 0px" }}
          transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
        >
          <MagicCard className="h-full rounded-[26px]" gradientSize={320} gradientColor="rgba(169,196,183,0.12)" gradientFrom="#c9ffe9" gradientTo="#5e7f72">
            <div className="lp-tile-inner min-h-[460px]">
              <span className="mb-4 w-fit rounded-full border border-white/10 px-2.5 py-1 font-mono text-[10.5px] text-white/50">wNEAR · USDC · ETH</span>
              <h3>Allocation targets</h3>
              <p>Choose the share each asset should hold. When the book drifts from your targets, the next scheduled run swaps it back, within your limits.</p>
              <AllocationChart />
            </div>
          </MagicCard>
          <BorderBeam size={220} duration={9} colorFrom="#ffffff" colorTo="#7fb39c" borderWidth={1.5} />
        </motion.article>
        <Tile className="md:col-span-5" title="Signed spending limits" body="Daily, weekly and monthly budgets in USD, plus a cap for each asset. You sign them, and the agent can't spend past them.">
          <BudgetRings />
        </Tile>
        <Tile className="md:col-span-5" title="Confidential balances" body="Shield public balances into a confidential balance, held privately for your Treasury.">
          <GlassCube />
        </Tile>
        <Tile className="md:col-span-6" title="Scheduled rebalancing" body="Autopilot runs on the schedule you set and brings drift back to target. It starts off; you turn it on, and you can stop it.">
          <RebalanceBand />
        </Tile>
        <Tile className="md:col-span-6" title="Owner stays in control" body="Approve each policy change in your wallet. Until you do, the agent keeps working under the policy you signed last.">
          <WalletApproval />
        </Tile>
      </div>
    </div>
  </section>;
}

/* ---------- 4. Security ---------- */

const POINTS = [
  { title: "Signed limits", body: "The agent works inside the daily, weekly and monthly budgets and per-asset caps that you signed.", icon: ShieldCheck, at: 0.14, place: "left-[4%] top-[26%] xl:left-[8%]" },
  { title: "Owner approval", body: "A policy change takes effect only after you approve it in your NEAR wallet.", icon: Wallet, at: 0.4, place: "right-[4%] top-[40%] xl:right-[8%]" },
  { title: "Sign-in moves no funds", body: "Sign-in signs a message. It moves no funds.", icon: LockSimple, at: 0.66, place: "left-[7%] bottom-[12%] xl:left-[13%]" },
];

function Point({ point, index, progress }: { point: (typeof POINTS)[number]; index: number; progress: MotionValue<number> }) {
  const opacity = useTransform(progress, [point.at, point.at + 0.1], [0, 1]);
  const y = useTransform(progress, [point.at, point.at + 0.1], [30, 0]);
  const blur = useTransform(progress, [point.at, point.at + 0.1], ["blur(10px)", "blur(0px)"]);
  const Icon = point.icon;
  return <motion.div className={`lp-point hidden md:block ${point.place}`} style={{ opacity, y, filter: blur }}>
    <div className="lp-point-card">
      <div className="mb-3 flex items-center justify-between">
        <span className="grid size-9 place-items-center rounded-full border border-[#c9ffe9]/30 bg-[#c9ffe9]/[0.06] text-[#e6fff4] shadow-[0_0_20px_-6px_#c9ffe9]"><Icon size={17} aria-hidden="true" /></span>
        <span className="lp-point-index">0{index + 1}</span>
      </div>
      <h3>{point.title}</h3>
      <p>{point.body}</p>
    </div>
  </motion.div>;
}

/** On narrow screens the points take turns in one slot under the vault. */
function MobilePoints({ progress }: { progress: MotionValue<number> }) {
  const [current, setCurrent] = useState(0);
  useMotionValueEvent(progress, "change", value => {
    const index = POINTS.reduce((found, point, i) => (value >= point.at ? i : found), 0);
    setCurrent(index);
  });
  const point = POINTS[current]!;
  const Icon = point.icon;
  return <div className="absolute inset-x-4 bottom-[9%] md:hidden">
    <motion.div key={current} className="lp-point-card" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
      <div className="mb-2 flex items-center gap-3">
        <span className="grid size-8 place-items-center rounded-full border border-[#c9ffe9]/30 text-[#e6fff4]"><Icon size={15} aria-hidden="true" /></span>
        <span className="lp-point-index">0{current + 1}/03</span>
      </div>
      <h3>{point.title}</h3>
      <p>{point.body}</p>
    </motion.div>
  </div>;
}

function Security() {
  const ref = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end end"] });
  const turn = useRef(0);
  useMotionValueEvent(scrollYProgress, "change", value => { turn.current = value; });
  return <section ref={ref} id="security" data-lp-section="4" aria-label="Security" className="relative h-[320vh]">
    <div className="sticky top-0 h-svh overflow-hidden">
      <Suspense fallback={<div className="lp-fallback" aria-hidden="true"><span style={{ top: "52%" }} /></div>}>
        <VaultScene className="absolute inset-0" lift={-0.15} progress={turn} floor={false} />
      </Suspense>
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-[22%] bg-gradient-to-b from-[#050506] to-transparent" />
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-[22%] bg-gradient-to-t from-[#050506] to-transparent" />
      <div className="absolute inset-x-0 top-[9%] z-10 flex flex-col items-center gap-4 px-4 text-center sm:top-[11%]">
        <Label index={4}>Security</Label>
        <Scramble text="Limits you sign. Approval you give." className="lp-h2 max-w-3xl !text-[clamp(1.9rem,3.6vw,3.6rem)]" />
      </div>
      {POINTS.map((point, i) => <Point key={point.title} point={point} index={i} progress={scrollYProgress} />)}
      <MobilePoints progress={scrollYProgress} />
    </div>
  </section>;
}

/* ---------- 5. FAQ, the final call and the footer ---------- */

const FAQ = [
  { q: "What does signing in do?", a: "Sign-in signs a message with your NEAR wallet so the app knows it's you. It moves no funds." },
  { q: "Who sets the limits?", a: "You do. You sign daily, weekly and monthly budgets in USD and a cap for each asset, and the agent works inside them." },
  { q: "Does the agent rebalance on its own?", a: "Only on autopilot, which starts off. Once you turn it on, it runs on the schedule you set and swaps toward your allocation targets, inside your signed limits." },
  { q: "What is a confidential balance?", a: "Shielding moves public balances into a confidential balance, held privately for your Treasury rather than shown in public." },
  { q: "Can I stop it?", a: "Yes. You can stop the schedule at any time, and a wallet owner can freeze the agent, which halts every send." },
];

function Faq() {
  return <section id="faq" data-lp-section="5" aria-label="FAQ" className="relative py-28 sm:py-36">
    <div className="lp-container grid gap-12 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <div className="flex flex-col gap-5">
        <Label index={5}>FAQ</Label>
        <Scramble text="Questions, answered plainly." className="lp-h2" />
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

function FinalCall({ selfService }: { selfService: boolean }) {
  return <section aria-label="Connect" className="relative overflow-hidden py-36 sm:py-48">
    <div className="lp-final-glow" aria-hidden="true" />
    {[360, 560, 780, 1020].map((size, i) => <span key={size} className="lp-final-ring" style={{ width: size, height: size, opacity: 1 - i * 0.2 }} aria-hidden="true" />)}
    <motion.div
      className="lp-container relative flex flex-col items-center gap-7 text-center"
      initial={{ opacity: 0, y: 40, filter: "blur(10px)" }}
      whileInView={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      viewport={{ once: true, margin: "-10% 0px" }}
      transition={{ duration: 1.1, ease: [0.16, 1, 0.3, 1] }}
    >
      <Logo className="size-14 drop-shadow-[0_0_24px_rgba(201,255,233,0.5)]" />
      <h2 className="lp-h2 !text-[clamp(2.6rem,6.4vw,6.6rem)]">Set the limits.<br /><span className="lp-fade-word">Let it run.</span></h2>
      <p className="max-w-md text-[16px] leading-relaxed text-white/60">Sign-in signs a message. It moves no funds.</p>
      <SignIn primary containerClassName="lp-signin" className="lp-btn lp-btn-lg" />
      <div className="flex max-w-md flex-col gap-1 text-[12.5px] leading-relaxed text-white/45">
        <p>{selfService ? "Connect your NEAR wallet to create or open a Treasury for yourself or an existing DAO." : "Connect your NEAR wallet to open your Treasury. Creation is available only on hosts with registration enabled."}</p>
        {selfService && <p>Registration signs nothing. Scheduling starts off.</p>}
      </div>
    </motion.div>
  </section>;
}

function Footer() {
  const links = [["Product", "product"], ["How it works", "how"], ["Security", "security"], ["FAQ", "faq"]] as const;
  return <footer className="border-t border-white/[0.06] py-12">
    <div className="lp-container flex flex-col gap-8 md:flex-row md:items-center md:justify-between">
      <div className="flex items-center gap-3">
        <Logo className="size-8" />
        <div className="flex flex-col">
          <span className="font-heading text-sm font-semibold tracking-tight">Agentic Treasury</span>
          <span className="text-[12.5px] text-white/45">Runs on NEAR, NEAR Intents and MultiAgency.</span>
        </div>
      </div>
      <ul className="flex flex-wrap gap-x-6 gap-y-2 text-[13px] text-white/55">
        {links.map(([label, id]) => <li key={id}><a href={`#${id}`} className="inline-flex items-center gap-1 transition-colors hover:text-white" onClick={event => { event.preventDefault(); scrollToSection(id); }}>{label}<ArrowUpRight size={11} aria-hidden="true" /></a></li>)}
      </ul>
      <p className="text-[12.5px] text-white/40">Sign-in signs a message. It moves no funds.</p>
    </div>
  </footer>;
}

export default function LandingSections({ selfService }: { selfService: boolean }) {
  return <>
    <RunsOn />
    <Manifesto />
    <HowItWorks />
    <Security />
    <Faq />
    <FinalCall selfService={selfService} />
    <Footer />
  </>;
}
