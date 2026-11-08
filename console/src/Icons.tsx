// One small outline icon set (24px grid, currentColor) so every surface uses the same strokes.
// Stroke 1.75 matches the 500-600 weight labels beside them.
import type { ReactNode, SVGProps } from "react";

function Icon({ children, size = 16, ...props }: SVGProps<SVGSVGElement> & { size?: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>
      {children}
    </svg>
  );
}

type P = { size?: number; className?: string };

export const FlameIcon = (p: P) => (
  <Icon {...p}><path d="M12 3c.5 3.2 4.5 5.4 4.5 10a4.5 4.5 0 0 1-9 0c0-2 1-3.4 2-4.5.3 1.6 1.1 2.6 2 3 0-2.8-.4-5.6.5-8.5Z" /></Icon>
);
export const PinIcon = (p: P) => (
  <Icon {...p}><path d="M12 21s-6.5-5.6-6.5-11A6.5 6.5 0 0 1 18.5 10c0 5.4-6.5 11-6.5 11Z" /><circle cx="12" cy="10" r="2.3" /></Icon>
);
export const CheckIcon = (p: P) => (
  <Icon {...p}><path d="m5 12.5 4.5 4.5L19 7.5" /></Icon>
);
export const ReplayIcon = (p: P) => (
  <Icon {...p}><path d="M4 12a8 8 0 1 0 2.4-5.7" /><path d="M4 4v4.5h4.5" /></Icon>
);
export const SparkIcon = (p: P) => (
  <Icon {...p}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.5 2.5M15.2 15.2l2.5 2.5M6.3 17.7l2.5-2.5M15.2 8.8l2.5-2.5" /></Icon>
);
export const StairsIcon = (p: P) => (
  <Icon {...p}><path d="M4 20h4.5v-4.5H13V11h4.5V6.5H21" /><path d="M4 20V15" /></Icon>
);
export const PulseIcon = (p: P) => (
  <Icon {...p}><path d="M3 12h4l2.5-6 5 12 2.5-6h4" /></Icon>
);
export const UsersIcon = (p: P) => (
  <Icon {...p}><circle cx="9" cy="8" r="3.2" /><path d="M3.5 19.5a5.5 5.5 0 0 1 11 0" /><path d="M16 5.2a3.2 3.2 0 0 1 0 6M17.5 19.5a5.5 5.5 0 0 0-2-4.2" /></Icon>
);
export const SendIcon = (p: P) => (
  <Icon {...p}><path d="M5 12h13M13 6l6 6-6 6" /></Icon>
);
export const SunIcon = (p: P) => (
  <Icon {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" /></Icon>
);
export const MoonIcon = (p: P) => (
  <Icon {...p}><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" /></Icon>
);
export const PlayIcon = (p: P) => (
  <Icon {...p}><path d="M8 5.6v12.8a.6.6 0 0 0 .92.5l10-6.4a.6.6 0 0 0 0-1l-10-6.4a.6.6 0 0 0-.92.5Z" /></Icon>
);
export const PauseIcon = (p: P) => (
  <Icon {...p}><rect x="6.5" y="5" width="3.5" height="14" rx="1" /><rect x="14" y="5" width="3.5" height="14" rx="1" /></Icon>
);
export const ChevronUpIcon = (p: P) => (
  <Icon {...p}><path d="m6 14.5 6-6 6 6" /></Icon>
);
export const ChevronDownIcon = (p: P) => (
  <Icon {...p}><path d="m6 9.5 6 6 6-6" /></Icon>
);
export const FitIcon = (p: P) => (
  <Icon {...p}><path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15" /></Icon>
);
