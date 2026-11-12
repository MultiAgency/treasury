import { Environment, Float, Lightformer, MeshTransmissionMaterial, RoundedBox } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, Noise, Vignette } from "@react-three/postprocessing";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import * as THREE from "three";

/**
 * The landing's glass vault: a refracting cube with a glowing core, the treasury's three tokens orbiting it as coins,
 * a sage aurora behind it and a lit grid below. Loaded lazily (`React.lazy`, from the landing), so the signed-in
 * pages never load three.js. Decorative: the whole canvas is hidden from assistive technology. With reduced motion it
 * draws one still frame and nothing moves after it, not even with the pointer.
 */

const BG = "#050506";

/** The pointer across the whole window, -1..1, shared by every canvas on the page. */
const pointer = { x: 0, y: 0 };
let listening = false;
function listenToPointer() {
  if (listening) return;
  listening = true;
  window.addEventListener("pointermove", event => {
    pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
    pointer.y = (event.clientY / window.innerHeight) * 2 - 1;
  }, { passive: true });
}

const linear = (hex: string) => new THREE.Color(hex);

/** A soft, slowly drifting sage aurora that the glass refracts. */
function Aurora({ z = -5 }: { z?: number }) {
  const material = useRef<THREE.ShaderMaterial>(null);
  const { camera, viewport } = useThree();
  const size = viewport.getCurrentViewport(camera, new THREE.Vector3(0, 0, z));
  const uniforms = useMemo(() => ({
    uTime: { value: 0 },
    uBg: { value: linear(BG) },
    uA: { value: linear("#8FE0BC") },
    uB: { value: linear("#3FA37C") },
    uC: { value: linear("#C9FFE9") },
    uAspect: { value: 1 },
  }), []);
  useFrame((_, delta) => {
    if (!material.current) return;
    material.current.uniforms.uTime!.value += delta;
    material.current.uniforms.uAspect!.value = size.width / size.height;
  });
  return <mesh position={[0, 0, z]} scale={[size.width * 1.25, size.height * 1.25, 1]}>
    <planeGeometry />
    <shaderMaterial ref={material} uniforms={uniforms} depthWrite={false}
      vertexShader={/* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`}
      fragmentShader={/* glsl */`
        uniform float uTime; uniform float uAspect; uniform vec3 uBg; uniform vec3 uA; uniform vec3 uB; uniform vec3 uC;
        varying vec2 vUv;
        float blob(vec2 uv, vec2 c, float r) { vec2 d = uv - c; d.x *= uAspect; return exp(-dot(d, d) / (r * r)); }
        void main() {
          vec2 uv = vUv;
          float t = uTime;
          vec3 col = uBg;
          col += uA * blob(uv, vec2(0.22 + 0.05 * sin(t * 0.13), 0.70 + 0.04 * cos(t * 0.11)), 0.22) * 0.24;
          col += uB * blob(uv, vec2(0.80 + 0.04 * cos(t * 0.09), 0.62 + 0.05 * sin(t * 0.15)), 0.26) * 0.32;
          col += uB * blob(uv, vec2(0.14 + 0.03 * cos(t * 0.07), 0.24), 0.20) * 0.18;
          col += uC * blob(uv, vec2(0.50 + 0.04 * sin(t * 0.07), 0.66 + 0.03 * sin(t * 0.21)), 0.13) * 0.16;
          float edge = smoothstep(0.0, 0.18, uv.x) * smoothstep(1.0, 0.82, uv.x) * smoothstep(0.0, 0.22, uv.y) * smoothstep(1.0, 0.86, uv.y);
          gl_FragColor = vec4(mix(uBg, col, edge), 1.0);
        }`} />
  </mesh>;
}

/** A floor of fine mint lines that fades out from under the vault, like a lit vault floor. */
function Grid({ y }: { y: number }) {
  const uniforms = useMemo(() => ({ uLine: { value: linear("#9FD8BF") }, uTime: { value: 0 } }), []);
  const material = useRef<THREE.ShaderMaterial>(null);
  useFrame((_, delta) => { if (material.current) material.current.uniforms.uTime!.value += delta; });
  return <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, y, -1]}>
    <planeGeometry args={[24, 16]} />
    <shaderMaterial ref={material} uniforms={uniforms} transparent depthWrite={false}
      vertexShader={/* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`}
      fragmentShader={/* glsl */`
        uniform vec3 uLine; uniform float uTime; varying vec2 vUv;
        void main() {
          vec2 p = (vUv - 0.5) * vec2(24.0, 16.0);
          vec2 g = abs(fract(p * 1.25 - 0.5) - 0.5) / fwidth(p * 1.25);
          float line = 1.0 - min(min(g.x, g.y), 1.0);
          float d = length(p * vec2(1.0, 1.6));
          float fade = exp(-d * d / 18.0);
          float sweep = 0.5 + 0.5 * sin(d * 1.4 - uTime * 1.2);
          gl_FragColor = vec4(uLine, line * fade * (0.10 + 0.16 * sweep));
        }`} />
  </mesh>;
}

type Token = { glyph: string; body: string; glow: string };
const TOKENS: Token[] = [
  { glyph: "N", body: "#dfeae5", glow: "#c9ffe9" },
  { glyph: "$", body: "#9fbcb0", glow: "#e9fff6" },
  { glyph: "Ξ", body: "#c9c4e6", glow: "#ece6ff" },
];

/** A coin face, drawn on a canvas so nothing is fetched: the colour map, and the glyph alone for the glow. */
function face(glyph: string, glowOnly: boolean, glow: string) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 512;
  const g = canvas.getContext("2d")!;
  if (glowOnly) {
    g.fillStyle = "#000";
    g.fillRect(0, 0, 512, 512);
  } else {
    const fill = g.createRadialGradient(190, 170, 10, 256, 256, 300);
    fill.addColorStop(0, "#36423d");
    fill.addColorStop(1, "#0b0e0d");
    g.fillStyle = fill;
    g.fillRect(0, 0, 512, 512);
  }
  // A cylinder's cap maps the canvas a quarter turn round; turn the drawing back so glyphs stand upright.
  g.translate(256, 256);
  g.rotate(-Math.PI / 2);
  g.translate(-256, -256);
  g.strokeStyle = glowOnly ? "rgba(255,255,255,0.9)" : "rgba(220,255,240,0.6)";
  g.lineWidth = 9;
  g.beginPath();
  g.arc(256, 256, 214, 0, Math.PI * 2);
  g.stroke();
  g.lineWidth = 2;
  g.strokeStyle = glowOnly ? "rgba(255,255,255,0.35)" : "rgba(220,255,240,0.25)";
  g.beginPath();
  g.arc(256, 256, 186, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = glowOnly ? "#fff" : glow;
  g.font = "600 220px ui-sans-serif, system-ui, -apple-system, 'Helvetica Neue', sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  if (glyph === "N") {
    // NEAR's N: two uprights joined by a diagonal, drawn rather than typed.
    g.strokeStyle = g.fillStyle as string;
    g.lineWidth = 34;
    g.lineCap = "round";
    g.lineJoin = "round";
    g.beginPath();
    g.moveTo(180, 340); g.lineTo(180, 172); g.lineTo(332, 340); g.lineTo(332, 172);
    g.stroke();
  } else g.fillText(glyph, 256, 268);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function Coin({ token, index, radius, mobile }: { token: Token; index: number; radius: number; mobile: boolean }) {
  const group = useRef<THREE.Group>(null);
  const spin = useRef<THREE.Group>(null);
  const materials = useMemo(() => {
    const map = face(token.glyph, false, token.glow);
    const emissiveMap = face(token.glyph, true, token.glow);
    const side = new THREE.MeshPhysicalMaterial({ color: token.body, metalness: 1, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.1 });
    const cap = new THREE.MeshPhysicalMaterial({
      color: "#ffffff", map, emissiveMap, emissive: new THREE.Color(token.glow), emissiveIntensity: 1.6,
      metalness: 0.85, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.05,
    });
    return [side, cap, cap];
  }, [token]);
  useEffect(() => () => materials.forEach(material => { material.map?.dispose(); material.emissiveMap?.dispose(); material.dispose(); }), [materials]);
  useFrame(state => {
    const t = state.clock.elapsedTime;
    const angle = t * 0.32 + index * (Math.PI * 2) / 3;
    if (group.current) {
      group.current.position.set(Math.cos(angle) * radius, Math.sin(angle * 2) * 0.12 + Math.sin(angle) * (mobile ? 0.35 : 0.5), Math.sin(angle) * radius * 0.55);
    }
    if (spin.current) spin.current.rotation.y = t * 0.9 + index * 1.7;
  });
  return <group ref={group}>
    <group ref={spin} rotation={[0, 0, 0.18]}>
      <mesh rotation={[Math.PI / 2, 0, 0]} material={materials}>
        <cylinderGeometry args={[0.34, 0.34, 0.075, 64, 1]} />
      </mesh>
    </group>
  </group>;
}

/** The core's light as an additive sprite drawn over the glass, so it reads hot through the refraction. */
function useGlowTexture() {
  return useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const g = canvas.getContext("2d")!;
    const fill = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    fill.addColorStop(0, "rgba(255,255,255,1)");
    fill.addColorStop(0.12, "rgba(230,255,244,0.9)");
    fill.addColorStop(0.35, "rgba(143,224,188,0.35)");
    fill.addColorStop(0.7, "rgba(63,163,124,0.08)");
    fill.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = fill;
    g.fillRect(0, 0, 256, 256);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }, []);
}

/** The moment a still vault shows: turned off its corner, the core's light at the low of its beat (sin(2.1t) = -1). */
const STILL_AT = (3 * Math.PI) / 2 / 2.1;

function Vault({ mobile, progress, still }: { mobile: boolean; progress?: RefObject<number>; still: boolean }) {
  const tilt = useRef<THREE.Group>(null);
  const turn = useRef<THREE.Group>(null);
  const core = useRef<THREE.Mesh>(null);
  const halo = useRef<THREE.Mesh>(null);
  const dialA = useRef<THREE.Mesh>(null);
  const dialB = useRef<THREE.Mesh>(null);
  const light = useRef<THREE.PointLight>(null);
  const glow = useRef<THREE.Sprite>(null);
  const glowTexture = useGlowTexture();
  const frame = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(0.92, 0.92, 0.92)), []);
  const rim = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(1.63, 1.63, 1.63)), []);
  useFrame((state, delta) => {
    // Still, the vault is drawn at one chosen moment (turned a little, its core between beats), whatever the pointer does.
    const t = still ? STILL_AT : state.clock.elapsedTime;
    const p = progress?.current ?? 0;
    const k = 1 - Math.exp(-delta * 3);
    const px = still ? 0 : pointer.x;
    const py = still ? 0 : pointer.y;
    if (tilt.current) {
      tilt.current.rotation.y += (px * 0.45 - tilt.current.rotation.y) * k;
      tilt.current.rotation.x += (py * 0.28 - tilt.current.rotation.x) * k;
    }
    if (turn.current) turn.current.rotation.y = t * 0.16 + p * Math.PI * 1.5;
    // Scroll brightens the core only a little: scaled up, lit up and bloomed at once, it flares out of the glass.
    const pulse = 1 + Math.sin(t * 2.1) * 0.05 + p * 0.02;
    core.current?.scale.setScalar(pulse);
    halo.current?.scale.setScalar(pulse * (1.9 + Math.sin(t * 1.3) * 0.08));
    glow.current?.scale.setScalar(0.95 * pulse);
    if (dialA.current) dialA.current.rotation.z = t * 0.6;
    if (dialB.current) dialB.current.rotation.z = -t * 0.45;
    if (light.current) light.current.intensity = 6 + Math.sin(t * 2.1) * 1.5 + p * 0.5;
    state.camera.position.x += (px * 0.35 - state.camera.position.x) * k;
    state.camera.position.y += (-py * 0.2 - state.camera.position.y) * k;
    state.camera.lookAt(0, 0, 0);
  });
  const scale = mobile ? 0.7 : 0.86;
  return <group ref={tilt}>
    <Float speed={still ? 0 : 1.4} rotationIntensity={0.25} floatIntensity={0.5} floatingRange={[-0.08, 0.08]}>
      <group scale={scale}>
        <group ref={turn}>
          {/* Seen corner-on, like a vault on a plinth. */}
          <group rotation={[Math.atan(1 / Math.SQRT2), Math.PI / 4, 0]}>
            <RoundedBox args={[1.7, 1.7, 1.7]} radius={0.14} smoothness={6}>
              <MeshTransmissionMaterial
                backside backsideThickness={0.35} thickness={0.9} samples={mobile ? 4 : 6} resolution={mobile ? 384 : 768}
                transmission={1} roughness={0.02} ior={1.38} chromaticAberration={0.12} anisotropicBlur={0.1}
                distortion={0.12} distortionScale={0.3} temporalDistortion={0.04} clearcoat={1} clearcoatRoughness={0}
                attenuationDistance={8} attenuationColor="#f2fff9" color="#ffffff" envMapIntensity={1.6} />
            </RoundedBox>
            <lineSegments geometry={frame}>
              <lineBasicMaterial color="#bff5dc" transparent opacity={0.3} />
            </lineSegments>
            {/* Crisp bright edges just inside the rounded glass, caught by the bloom. */}
            <lineSegments geometry={rim}>
              <lineBasicMaterial color={new THREE.Color(1.5, 1.9, 1.75)} toneMapped={false} transparent opacity={0.75} />
            </lineSegments>
          </group>
          <mesh ref={dialA} rotation={[Math.PI / 2.4, 0, 0]}>
            <torusGeometry args={[0.62, 0.006, 8, 160]} />
            <meshBasicMaterial color={new THREE.Color(1.6, 2.4, 2.0)} toneMapped={false} />
          </mesh>
          <mesh ref={dialB} rotation={[Math.PI / 2, Math.PI / 3, 0]}>
            <torusGeometry args={[0.5, 0.005, 8, 160, Math.PI * 1.4]} />
            <meshBasicMaterial color={new THREE.Color(1.8, 1.6, 2.6)} toneMapped={false} />
          </mesh>
        </group>
        <mesh ref={core}>
          <sphereGeometry args={[0.3, 48, 48]} />
          <meshBasicMaterial color={new THREE.Color(1.5, 2.1, 1.85)} toneMapped={false} />
        </mesh>
        <mesh ref={halo}>
          <sphereGeometry args={[0.3, 32, 32]} />
          <meshBasicMaterial color="#9fe8c8" transparent opacity={0.06} depthWrite={false} toneMapped={false} />
        </mesh>
        <sprite ref={glow} renderOrder={10}>
          <spriteMaterial map={glowTexture} color={new THREE.Color(0.5, 0.66, 0.6)} blending={THREE.AdditiveBlending} depthWrite={false} depthTest={false} transparent toneMapped={false} />
        </sprite>
        <pointLight ref={light} color="#c8ffe6" intensity={9} distance={5} decay={1.6} />
      </group>
      {TOKENS.map((token, index) => <Coin key={token.glyph} token={token} index={index} radius={mobile ? 1.2 : 1.6} mobile={mobile} />)}
    </Float>
  </group>;
}

function Studio() {
  return <Environment resolution={256} frames={1}>
    <Lightformer form="rect" intensity={4} color="#ffffff" position={[0, 5, -2]} scale={[10, 2, 1]} rotation-x={Math.PI / 2} />
    <Lightformer form="rect" intensity={6} color="#a8ffd8" position={[-5, 1, 1]} scale={[2, 6, 1]} rotation-y={Math.PI / 2} />
    <Lightformer form="rect" intensity={4} color="#b8a8ff" position={[5, 0, -1]} scale={[1.2, 6, 1]} rotation-y={-Math.PI / 2} />
    <Lightformer form="ring" intensity={2.4} color="#e8fff5" position={[0, 0, 6]} scale={3} />
    <Lightformer form="rect" intensity={1} color="#5e7f72" position={[0, -4, 0]} scale={[10, 10, 1]} rotation-x={-Math.PI / 2} />
  </Environment>;
}

export type VaultSceneProps = {
  /** Where the vault sits in the view: the hero lifts it above the headline. */
  lift?: number;
  /** 0..1 from a scroll section: turns the vault and brightens its core. */
  progress?: RefObject<number>;
  /** Draw the floor grid. */
  floor?: boolean;
  className?: string;
  /** Loading stages for the intro: the renderer exists ("created"), then frames are on screen ("ready"). */
  onStage?: (stage: "created" | "ready") => void;
  /** Reduced motion: one still frame, drawn on demand, with no pointer tilt and no turning. */
  still?: boolean;
};

/**
 * Says "ready" once a few frames have actually been drawn, so the intro hands over to a vault that's there. Drawing on
 * demand (reduced motion), it asks for those first frames itself: the glass's refraction and the studio's lighting
 * need a frame drawn before they show, and then nothing is drawn again.
 */
function ReadySignal({ onReady }: { onReady: () => void }) {
  const frames = useRef(0);
  const invalidate = useThree(state => state.invalidate);
  useFrame(() => {
    frames.current += 1;
    if (frames.current < 3) invalidate();
    if (frames.current === 3) onReady();
  });
  return null;
}

export default function VaultScene({ lift = 0, progress, floor = true, className, onStage, still = false }: VaultSceneProps) {
  const host = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(true);
  const [shown, setShown] = useState(false);
  const [mobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    if (!still) listenToPointer();
    const observer = new IntersectionObserver(([entry]) => setActive(Boolean(entry?.isIntersecting)), { rootMargin: "120px" });
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, [still]);
  return <div ref={host} aria-hidden="true" className={className} style={{ opacity: shown ? 1 : 0, transition: "opacity 1.1s ease" }}>
    <Canvas
      // The device pixel ratio is capped: a 3x phone draws at 1.5x, a retina screen at 1.75x.
      dpr={[1, mobile ? 1.5 : 1.75]}
      // Off screen, nothing is drawn; with reduced motion, only the first frames are.
      frameloop={still ? "demand" : active ? "always" : "never"}
      gl={{ antialias: false, alpha: false, powerPreference: "high-performance", stencil: false }}
      camera={{ position: [0, 0, mobile ? 10.5 : 8], fov: 35 }}
      onCreated={state => { state.gl.setClearColor(BG); onStage?.("created"); }}
    >
      <color attach="background" args={[BG]} />
      <ReadySignal onReady={() => { setShown(true); onStage?.("ready"); }} />
      <Aurora />
      <Studio />
      <ambientLight intensity={0.15} />
      <group position={[0, lift, 0]}>
        {floor && <Grid y={mobile ? -1.5 : -1.75} />}
        <Vault mobile={mobile} progress={progress} still={still} />
      </group>
      <EffectComposer multisampling={mobile ? 0 : 4}>
        <Bloom mipmapBlur luminanceThreshold={0.92} luminanceSmoothing={0.12} intensity={0.85} radius={0.6} />
        <Noise opacity={0.035} premultiply />
        <Vignette offset={0.32} darkness={0.6} />
      </EffectComposer>
    </Canvas>
  </div>;
}
