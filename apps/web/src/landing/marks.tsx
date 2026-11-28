/** Landing-only icons, drawn like icons.tsx: 1.5px stroke, currentColor, decorative by default. */
import type { SVGProps } from "react";

const base = (props: SVGProps<SVGSVGElement>) => ({
  width: 15,
  height: 15,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  ...props,
});

export const ChatIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 17h-8l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5Z" />
  </svg>
);
export const ArrowDownIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M12 5v13" />
    <path d="m6 12 6 6 6-6" />
  </svg>
);
export const BlockIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="8" />
    <path d="m6.5 6.5 11 11" />
  </svg>
);
export const LanguageIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="8" />
    <path d="M4 12h16" />
    <path d="M12 4c2.2 2.3 3.3 5 3.3 8s-1.1 5.7-3.3 8c-2.2-2.3-3.3-5-3.3-8S9.8 6.3 12 4Z" />
  </svg>
);

/** Concentric rings, as on the deck's cover: drawn once, faded toward the edges. */
export function Rings({ count = 9, step = 70, start = 60, color = "#cc5500", opacity = 0.16, className }: { count?: number; step?: number; start?: number; color?: string; opacity?: number; className?: string }) {
  const size = (start + step * count) * 2 + 4;
  const c = size / 2;
  return (
    <svg className={className} viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true" focusable="false">
      {Array.from({ length: count }, (_, i) => (
        <circle key={i} cx={c} cy={c} r={start + step * i} fill="none" stroke={color} strokeWidth={1} strokeOpacity={opacity * (1 - i / (count + 1))} />
      ))}
    </svg>
  );
}
