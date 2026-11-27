// Scroll behaviour that respects "reduce motion" (U-3). CSS scroll-behavior is already forced to auto for reduced motion,
// but an explicit {behavior: 'smooth'} in script is not covered by CSS, so scripts ask here.
export const motionBehavior = () => (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');
