interface BlinkingCursorProps {
  label?: string;
  className?: string;
}

/**
 * Blinking block cursor, optionally prefixed with a label like "LOADING".
 * Used for loading and empty states across the app.
 */
export function BlinkingCursor({ label, className = "" }: BlinkingCursorProps) {
  return (
    <span
      className={`font-[family-name:var(--font-display)] text-banana ${className}`}
    >
      {label}
      <span className="blink">█</span>
    </span>
  );
}
