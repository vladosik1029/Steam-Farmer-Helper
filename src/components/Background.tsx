import React, { useMemo } from 'react';
import type { BackgroundId } from '../lib/prefs';

export const BACKGROUNDS: { id: BackgroundId; name: string; animated: boolean }[] = [
  { id: 'ember', name: 'Тёплое свечение', animated: false },
  { id: 'dunes', name: 'Дюны', animated: false },
  { id: 'grain', name: 'Графит с зерном', animated: false },
  { id: 'aurora', name: 'Янтарное сияние', animated: true },
  { id: 'embers', name: 'Искры', animated: true },
  { id: 'sunset', name: 'Медленный закат', animated: true }
];

function Embers() {
  // Stable random layout so particles don't jump on re-render
  const particles = useMemo(() => Array.from({ length: 28 }, (_, i) => ({
    left: `${(i * 37) % 100}%`,
    duration: `${14 + ((i * 7) % 12)}s`,
    delay: `-${(i * 3.1) % 20}s`,
    drift: `${((i % 5) - 2) * 25}px`,
    size: 2 + (i % 3)
  })), []);

  return (
    <>
      {particles.map((p, i) => (
        <span
          key={i}
          className="ember-particle"
          style={{
            left: p.left,
            width: p.size,
            height: p.size,
            animationDuration: p.duration,
            animationDelay: p.delay,
            ['--drift' as any]: p.drift
          }}
        />
      ))}
    </>
  );
}

export function Background({ id }: { id: BackgroundId }) {
  return (
    <div className={`bg-layer bg-${id}`} aria-hidden>
      {id === 'embers' && <Embers />}
    </div>
  );
}

// Small swatch used in settings
export function BackgroundPreview({ id }: { id: BackgroundId }) {
  return (
    <div className={`relative h-20 rounded-xl overflow-hidden border border-line bg-${id}`}>
      {id === 'embers' && <Embers />}
    </div>
  );
}
