import React from "react";
import type { FaceState } from "../shared/types.js";

interface Particle {
  angle: number; // degrees, starting position around the core
  radius: number; // px from center in the 200x200 viewBox
  size: number; // circle radius
  duration: number; // orbit period, seconds — varied for organic motion
  reverse: boolean;
  twinkleDelay: number;
  twinkleDuration: number;
}

const PARTICLE_COUNT = 26;

/** Deterministic pseudo-random field, generated once at module load — an
 * organic-looking scatter that's stable across re-renders (no per-render
 * Math.random(), which would make particles jump on every state change). */
function makeParticles(): Particle[] {
  let seed = 1337;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed % 10000) / 10000;
  };
  const particles: Particle[] = [];
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    particles.push({
      angle: rand() * 360,
      radius: 32 + rand() * 48,
      size: 1.1 + rand() * 2.1,
      duration: 9 + rand() * 24,
      reverse: rand() > 0.5,
      twinkleDelay: rand() * 4,
      twinkleDuration: 1.5 + rand() * 2.3
    });
  }
  return particles;
}

const PARTICLES = makeParticles();

/**
 * Mimir's visual presence: a particle field orbiting a glowing core — in
 * the spirit of Siri's shimmering points of light and Jarvis's HUD energy
 * sphere, rather than either a mechanical reticle or an undifferentiated
 * blur. State is communicated through orbit/pulse speed, glow, and palette
 * (the app's own amber/copper identity, not a literal Apple color scheme).
 */
export default function Face({ state }: { state: FaceState }) {
  return (
    <div className={`orb orb--${state}`} aria-label={`Mimir core is ${state}`}>
      <svg viewBox="0 0 200 200" width="172" height="172" role="img">
        <defs>
          <filter id="orb-particle-glow" x="-200%" y="-200%" width="500%" height="500%">
            <feGaussianBlur stdDeviation="1" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id="orb-core-glow" x="-150%" y="-150%" width="400%" height="400%">
            <feGaussianBlur stdDeviation="3.5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <radialGradient id="orb-halo" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.6" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </radialGradient>
        </defs>

        <g className="orb-color">
          <circle cx="100" cy="100" r="90" className="orb-ring orb-ring--outer" />
          <circle cx="100" cy="100" r="62" className="orb-ring orb-ring--inner" />

          <circle cx="100" cy="100" r="34" fill="url(#orb-halo)" className="orb-halo" />

          <g className="orb-particle-field" filter="url(#orb-particle-glow)">
            {PARTICLES.map((p, i) => (
              <g
                key={i}
                className="orb-particle-orbit"
                style={{
                  transformOrigin: "100px 100px",
                  animationDuration: `${p.duration}s`,
                  animationDirection: p.reverse ? "reverse" : "normal"
                }}
              >
                <circle
                  className="orb-particle"
                  cx={100 + p.radius * Math.cos((p.angle * Math.PI) / 180)}
                  cy={100 + p.radius * Math.sin((p.angle * Math.PI) / 180)}
                  r={p.size}
                  style={{
                    animationDelay: `${p.twinkleDelay}s`,
                    animationDuration: `${p.twinkleDuration}s`
                  }}
                />
              </g>
            ))}
          </g>

          <circle cx="100" cy="100" r="9" className="orb-core" filter="url(#orb-core-glow)" />
        </g>
      </svg>
    </div>
  );
}
