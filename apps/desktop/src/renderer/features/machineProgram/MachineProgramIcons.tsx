import React from "react";

// The pictures the Machine Program workspace is drawn with, in one place so the same machine,
// the same injector and the same clock appear wherever they are named — the header control, the
// machine down the left, the injector card and the quick view all share these.
//
// Plain strokes in `currentColor`, no fills and no gradients: they take the colour of whatever
// they sit in, and they do not stall the first draw (see the GPU notes in theme.css).
//
// Every one is decorative. The word it stands beside is what is announced (R18), so each is
// hidden from the screen reader.

type IconProps = { className?: string };

const svg = (children: React.ReactNode, className?: string) => (
  <svg className={className ? `mpx-icon ${className}` : "mpx-icon"} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    {children}
  </svg>
);

/** A cog: the workspace itself. */
export const GearIcon: React.FC<IconProps> = ({ className }) =>
  svg(
    <>
      <circle cx="12" cy="12" r="3.1" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M19.4 14.6a7.6 7.6 0 0 0 0-5.2l1.7-1.3-1.9-3.2-2 .8a7.7 7.7 0 0 0-4.5-2.6L12.4 1h-3.7l-.3 2.1A7.7 7.7 0 0 0 3.9 5.7l-2-.8L0 8.1l1.7 1.3a7.6 7.6 0 0 0 0 5.2L0 15.9l1.9 3.2 2-.8a7.7 7.7 0 0 0 4.5 2.6l.3 2.1h3.7l.3-2.1a7.7 7.7 0 0 0 4.5-2.6l2 .8 1.9-3.2-1.7-1.3z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
        transform="translate(1.5 0.5) scale(0.88)"
      />
    </>,
    className
  );

/** A moulding machine: a cabinet with a panel and two feet. */
export const MachineIcon: React.FC<IconProps> = ({ className }) =>
  svg(
    <>
      <rect x="3" y="5" width="18" height="13" rx="2.2" stroke="currentColor" strokeWidth="1.8" />
      <rect x="6" y="8" width="7" height="5" rx="1" stroke="currentColor" strokeWidth="1.6" />
      <path d="M16.5 8.5v4M6 21h3M15 21h3M7.5 18v3M16.5 18v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </>,
    className
  );

/** An injector: a barrel with a nozzle under it. */
export const InjectorIcon: React.FC<IconProps> = ({ className }) =>
  svg(
    <>
      <rect x="7.5" y="3" width="9" height="12" rx="3" stroke="currentColor" strokeWidth="1.8" />
      <path d="M7.5 8h9M12 15v3M10 18h4l-1 3h-2l-1-3z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    </>,
    className
  );

/** A clock: the shift a program runs. */
export const ClockIcon: React.FC<IconProps> = ({ className }) =>
  svg(
    <>
      <circle cx="12" cy="12" r="8.6" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 7.2V12l3.2 2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </>,
    className
  );

/** A calendar: the date a program is for. */
export const CalendarIcon: React.FC<IconProps> = ({ className }) =>
  svg(
    <>
      <rect x="3.4" y="5" width="17.2" height="15.5" rx="2.2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M3.4 9.6h17.2M8 3.2v3.4M16 3.2v3.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </>,
    className
  );

/** A stack of cartons: what the machine's day adds up to. */
export const ProductionIcon: React.FC<IconProps> = ({ className }) =>
  svg(
    <>
      <path d="M12 2.8l8.4 4.4v9.6L12 21.2 3.6 16.8V7.2L12 2.8z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M3.6 7.2L12 11.6l8.4-4.4M12 11.6v9.6" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    </>,
    className
  );

/** A contractor: the person the machine runs for. */
export const PersonIcon: React.FC<IconProps> = ({ className }) =>
  svg(
    <>
      <circle cx="12" cy="8" r="3.6" stroke="currentColor" strokeWidth="1.8" />
      <path d="M4.8 20.2c0-3.6 3.2-5.8 7.2-5.8s7.2 2.2 7.2 5.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </>,
    className
  );

/** An i in a circle: the note that explains what a program does and does not do. */
export const InfoIcon: React.FC<IconProps> = ({ className }) =>
  svg(
    <>
      <circle cx="12" cy="12" r="8.6" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 11v5.4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <circle cx="12" cy="7.9" r="1.1" fill="currentColor" />
    </>,
    className
  );

/** A bin: taking something off the program. */
export const TrashIcon: React.FC<IconProps> = ({ className }) =>
  svg(
    <>
      <path d="M4.5 6.6h15M9.6 6.6V4.8c0-.7.6-1.3 1.3-1.3h2.2c.7 0 1.3.6 1.3 1.3v1.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M6.6 6.6l.9 12.1c.05.8.7 1.4 1.5 1.4h6c.8 0 1.45-.6 1.5-1.4l.9-12.1" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M10.3 10.4v6M13.7 10.4v6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </>,
    className
  );

/** A plus: adding a sole colour or an article. */
export const PlusIcon: React.FC<IconProps> = ({ className }) =>
  svg(<path d="M12 5.6v12.8M5.6 12h12.8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />, className);

/** The caret on a control that opens a list. */
export const CaretIcon: React.FC<IconProps> = ({ className }) =>
  svg(<path d="M6.5 9.5L12 15l5.5-5.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />, className);
