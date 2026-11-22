export function motionDuration(milliseconds = 200) {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : milliseconds;
}
