/** Inline icons: one set, 1.5px stroke (beside regular text), currentColor, decorative by default. */
import type { SVGProps } from "react";

const base = (props: SVGProps<SVGSVGElement>) => ({
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  ...props,
});

export const LockIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 1 1 8 0v3" />
  </svg>
);
export const SendIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M5 12h13" />
    <path d="m13 6 6 6-6 6" />
  </svg>
);
export const CheckIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </svg>
);
export const ClockIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 8v4l2.5 2.5" />
  </svg>
);
export const ShieldIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M12 3.5 5 6v5.5c0 4.2 2.9 7.6 7 9 4.1-1.4 7-4.8 7-9V6l-7-2.5Z" />
    <path d="m9.5 12 2 2 3-3.5" />
  </svg>
);
export const RefreshIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M19 12a7 7 0 1 1-2.05-4.95" />
    <path d="M19 5v4h-4" />
  </svg>
);
export const HelpIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="8" />
    <path d="M9.75 9.5a2.25 2.25 0 1 1 3.1 2.08c-.5.2-.85.68-.85 1.22V13.5" />
    <path d="M12 16.5h.01" />
  </svg>
);
export const ChevronIcon =(p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="m7 10 5 5 5-5" />
  </svg>
);
export const AlertIcon =(p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 8v4.5" />
    <path d="M12 16h.01" />
  </svg>
);

/** Marks AI-generated content: a four-point spark. */
export const SparkIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M12 3c.4 3.9 2.1 5.6 6 6-3.9.4-5.6 2.1-6 6-.4-3.9-2.1-5.6-6-6 3.9-.4 5.6-2.1 6-6Z" />
    <path d="M18.5 15.5c.2 1.6.9 2.3 2.5 2.5-1.6.2-2.3.9-2.5 2.5-.2-1.6-.9-2.3-2.5-2.5 1.6-.2 2.3-.9 2.5-2.5Z" />
  </svg>
);

export const MicIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </svg>
);

export const MicOffIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M15 9.5V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.6 2.5M5 11a7 7 0 0 0 11.5 5.4M19 11a7 7 0 0 1-.6 2.8M12 18v3M3 3l18 18" />
  </svg>
);

export const PhoneOffIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M10.7 13.3a15 15 0 0 1-2.9-4l1.6-1.6a1 1 0 0 0 .2-1.1L8.4 3.6A1 1 0 0 0 7.3 3H4a1 1 0 0 0-1 1.1A17 17 0 0 0 7.6 14.4M14 16.2a15 15 0 0 0 2.2 1l1.6-1.6a1 1 0 0 1 1.1-.2l3 1.2a1 1 0 0 1 .6 1V20a1 1 0 0 1-1.1 1 17 17 0 0 1-7.7-2.6M3 3l18 18" />
  </svg>
);

export const PhoneIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M21 16.9v3.1a1 1 0 0 1-1.1 1A17 17 0 0 1 3 4.1 1 1 0 0 1 4 3h3.1a1 1 0 0 1 1 .7l1.2 3a1 1 0 0 1-.2 1.1L7.5 9.4a15 15 0 0 0 7.1 7.1l1.6-1.6a1 1 0 0 1 1.1-.2l3 1.2a1 1 0 0 1 .7 1Z" />
  </svg>
);
