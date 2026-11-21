import { exposureRatio, motionTrails } from '../../../shared/instruments/camera';

type Shutter = Parameters<typeof exposureRatio>[0];
type ISO = Parameters<typeof exposureRatio>[1];

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K, attributes: Record<string, number | string>, ...children: SVGElement[]
): SVGElementTagNameMap[K] {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  node.append(...children);
  return node;
}

function cyclist(): SVGGElement {
  return svg('g', { id: 'rider' },
    svg('g', { fill: 'none', stroke: '#10261d', 'stroke-width': 2.6 },
      svg('circle', { cx: 9, cy: 26, r: 9 }),
      svg('circle', { cx: 40, cy: 26, r: 9 }),
      svg('path', { d: 'm9 26 12-16 9 16H9m12-16 15-1 4 17m-22-16h7m8-5h5l-2 4' }),
    ),
    svg('g', { stroke: '#273625', 'stroke-width': 4, 'stroke-linecap': 'round', fill: 'none' },
      svg('path', { d: 'm23 5 7-9 9 10 6 1m-22-2-5 9 10 7' }),
    ),
    svg('path', { d: 'm24 2 5-8 6 7-5 7z', fill: '#f3c66d' }),
    svg('circle', { cx: 33, cy: -10, r: 4, fill: '#222f25' }),
  );
}

function mountainRoad(): SVGSVGElement {
  return svg('svg', { width: '100%', height: '100%', viewBox: '0 0 580 200', preserveAspectRatio: 'none' },
    svg('path', { d: 'm0 104 68-36 46 17 83-65 72 60 54-21 88 33 59-40 110 43v105H0z', fill: '#658477' }),
    svg('path', { d: 'm0 84 75 33 93-50 41-28 91 83 61-20 76 8 91-39 52 9v120H0z', fill: '#486d60' }),
    svg('path', { d: 'm0 100 67 28 111-19 79 18 77-15 88 14 158-46v120H0z', fill: '#365a49' }),
    svg('path', { d: 'M0 147q98-24 184-12t194 0 202-21v86H0z', fill: '#95a174' }),
    svg('path', { d: 'M0 176q137-44 280-33t300-14v24q-170 29-307 9T0 200z', fill: '#d7c9a0' }),
    svg('path', { d: 'M0 197q157-48 282-34t298-10', fill: 'none', stroke: '#6f7658', 'stroke-width': 2 }),
  );
}

export function cyclistScene(shutter: Shutter, iso: ISO): SVGSVGElement {
  const exposure = exposureRatio(shutter, iso);
  const brightness = Math.min(1.6, Math.max(0.33, Math.pow(exposure, 0.45)));
  const trails = motionTrails(shutter);
  const motion = trails > 0 ? 'visible motion trail' : 'sharp outline';
  const light = exposure < 1 ? ', dim exposure' : '';
  const echoes = Array.from({ length: trails }, (_, index) =>
    svg('use', { href: '#rider', x: -(trails - index) * 2.7, opacity: 0.08 + index * 0.018 }));
  const scene = svg('svg', { role: 'img', 'aria-label': `A cyclist on a mountain road, ${motion}${light}` },
    svg('defs', {},
      svg('linearGradient', { id: 'sky', x2: 0, y2: 1 },
        svg('stop', { 'stop-color': '#769c90' }),
        svg('stop', { offset: 1, 'stop-color': '#f0da9d' })),
      cyclist(),
    ),
    svg('rect', { width: '100%', height: '100%', fill: 'url(#sky)' }),
    svg('circle', { cx: '78%', cy: '20%', r: 11, fill: '#f7e5ad' }),
    mountainRoad(),
    svg('svg', { x: '48%', y: '32%', width: '23%', height: '53%', viewBox: '-22 -18 78 61', overflow: 'visible' },
      ...echoes, svg('use', { href: '#rider' })),
  );
  scene.style.filter = `brightness(${brightness})`;
  return scene;
}
