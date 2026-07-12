import { HTMLAttributes } from "react";

interface PixelCardProps extends HTMLAttributes<HTMLDivElement> {
  accent?: boolean;
}

/**
 * Chunky bordered container with a hard drop shadow. The base building
 * block for every panel, sheet, and card in the app.
 */
export function PixelCard({
  accent = false,
  className = "",
  children,
  ...props
}: PixelCardProps) {
  return (
    <div
      className={`bg-grid ${
        accent ? "pixel-border-banana" : "pixel-border"
      } ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}
