const paths = {
  atlas: "M4 17l5-10 6 8 3-5 3 7M3 20h18",
  knowledge: "M5 7l7 5 7-6M12 12l4 7M5 7a2 2 0 1 0 0 .1M19 6a2 2 0 1 0 0 .1M16 19a2 2 0 1 0 0 .1",
  pr: "M7 5v14m10-2v-4c0-4-6-2-6-7m0 0 3 2m-3-2 2-3",
  profile: "M4 20v-6h4v6zm6 0V9h4v11zm6 0V4h4v16z",
  sun: "M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2 M16 12a4 4 0 1 1-8 0 4 4 0 1 1 8 0",
  moon: "M20 15A8.5 8.5 0 0 1 9 4a8.5 8.5 0 1 0 11 11",
  route: "M3 18h3c3 0 3-12 7-12h7m-4-3 4 3-4 3",
  layer: "m3 8 9-5 9 5-9 5zm0 5 9 5 9-5m-18 5 9 5 9-5",
  frame: "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5",
  book: "M3 5q5-2 9 1 4-3 9-1v14q-5-2-9 1-4-3-9-1zM12 6v14",
  lock: "M6 10h12v11H6zM9 10V7a3 3 0 1 1 6 0v3m-3 5v2",
  check: "m4 12 5 5L20 6",
} as const;

export function Icon({ name }: { name: keyof typeof paths }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}
