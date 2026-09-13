/**
 * Line icons in the app's own ink, instead of emoji. Emoji render differently on
 * every OS, carry their own colours, and read as decoration on a page whose job is
 * to be read as evidence. 14px, 1.5 stroke, currentColor.
 */
type P = { size?: number };
const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  style: { flexShrink: 0, display: "inline-block", verticalAlign: "-2px" },
});

/** Bars: the book. */
export const IconBook = ({ size = 14 }: P) => (
  <svg {...base(size)}>
    <path d="M2.5 13.5h11" />
    <path d="M4 13V8M7 13V4M10 13V9.5M13 13V6" />
  </svg>
);

/** Two linked nodes: across chains. */
export const IconChains = ({ size = 14 }: P) => (
  <svg {...base(size)}>
    <circle cx="4.5" cy="8" r="2.5" />
    <circle cx="11.5" cy="8" r="2.5" />
    <path d="M7 8h2" />
  </svg>
);

/** Receipt with lines: the proof. */
export const IconReceipt = ({ size = 14 }: P) => (
  <svg {...base(size)}>
    <path d="M4 2h8v12l-2-1.2L8 14l-2-1.2L4 14z" />
    <path d="M6 5.5h4M6 8h4" />
  </svg>
);

/** A shield: the solvency curve. */
export const IconShield = ({ size = 14 }: P) => (
  <svg {...base(size)}>
    <path d="M8 2l5 2v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4z" />
  </svg>
);

/** A wave: an illustrative shape. */
export const IconShape = ({ size = 14 }: P) => (
  <svg {...base(size)}>
    <path d="M2 11c2.5 0 3-6 6-6s3.5 6 6 6" />
  </svg>
);

/** Two panes: dual view. */
export const IconSplit = ({ size = 14 }: P) => (
  <svg {...base(size)}>
    <rect x="2" y="3" width="12" height="10" rx="1.5" />
    <path d="M8 3v10" />
  </svg>
);

/** Magnifier. */
export const IconInspect = ({ size = 14 }: P) => (
  <svg {...base(size)}>
    <circle cx="7" cy="7" r="4" />
    <path d="M10 10l3.5 3.5" />
  </svg>
);

/** A signal dot with rings. */
export const IconSignal = ({ size = 14 }: P) => (
  <svg {...base(size)}>
    <circle cx="8" cy="8" r="1.6" fill="currentColor" />
    <path d="M4.8 11.2a4.5 4.5 0 010-6.4M11.2 4.8a4.5 4.5 0 010 6.4" />
  </svg>
);
