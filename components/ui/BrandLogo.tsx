/** SWITCH's brand yellow (the two-arch mark). */
export const LOGO_YELLOW = "#F5C518";

/**
 * The SWITCH mark — two rounded arches (the closed-eyes / banana motif) in the
 * brand yellow. Pure SVG so it stays crisp at any size and needs no image asset.
 */
export function BrandLogo({
  size = 40,
  className = "",
  color = LOGO_YELLOW,
}: {
  size?: number;
  className?: string;
  color?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      role="img"
      aria-label="SWITCH"
      className={className}
    >
      <path
        d="M7 30 Q15 11 23 30"
        stroke={color}
        strokeWidth="5.6"
        strokeLinecap="round"
      />
      <path
        d="M25 30 Q33 11 41 30"
        stroke={color}
        strokeWidth="5.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Wordmark lockup: mark + "SWITCH" set in the display font. */
export function BrandWordmark({
  className = "",
  markSize = 30,
}: {
  className?: string;
  markSize?: number;
}) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <BrandLogo size={markSize} />
      <span className="font-[family-name:var(--font-display)] font-semibold tracking-[0.16em] text-cream text-xl">
        SWITCH
      </span>
    </div>
  );
}
