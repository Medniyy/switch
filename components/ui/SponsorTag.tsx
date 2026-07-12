/**
 * The sponsor tag shown on the opening gallery. Deliberately low-emphasis — a
 * small frosted pill that reads "presented by ATH". Visible but muted (no lime
 * fill, ~60% opacity) so it never shouts. Swap SPONSOR to change the partner.
 */
const SPONSOR = "ATH";

export function SponsorTag({ className = "" }: { className?: string }) {
  return (
    <div
      className={`glass rounded-full px-3 py-1.5 flex items-center gap-1.5 opacity-60 hover:opacity-90 transition-opacity ${className}`}
    >
      <span className="font-[family-name:var(--font-body)] text-[10px] uppercase tracking-[0.18em] text-cream/60">
        presented by
      </span>
      <span className="font-[family-name:var(--font-display)] text-xs font-semibold tracking-wide text-cream">
        {SPONSOR}
      </span>
    </div>
  );
}
