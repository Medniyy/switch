"use client";

import { ButtonHTMLAttributes, forwardRef } from "react";

type Variant = "primary" | "secondary" | "danger" | "ghost";
type Size = "sm" | "md" | "lg";

interface PixelButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const variants: Record<Variant, string> = {
  primary:
    "bg-banana text-screen hover:brightness-105 shadow-[0_8px_24px_-8px_rgba(198,244,50,0.5)]",
  secondary:
    "bg-grid text-cream border border-white/10 hover:border-white/25",
  danger: "bg-pixelred text-white hover:brightness-110",
  ghost:
    "bg-white/5 text-cream border border-white/12 hover:bg-white/10 hover:border-white/20",
};

const sizes: Record<Size, string> = {
  sm: "text-xs px-4 py-2 rounded-full",
  md: "text-sm px-5 py-3 rounded-full",
  lg: "text-base px-7 py-4 rounded-full",
};

/**
 * Modern pill button. Lime primary with a soft glow; ghost/secondary use a hair
 * border on frosted dark. Kept the `PixelButton` name + API so existing imports
 * keep working after the rebrand.
 */
export const PixelButton = forwardRef<HTMLButtonElement, PixelButtonProps>(
  function PixelButton(
    { variant = "primary", size = "md", className = "", children, ...props },
    ref
  ) {
    return (
      <button
        ref={ref}
        className={`
          font-[family-name:var(--font-display)] font-medium tracking-tight
          select-none inline-flex items-center justify-center gap-2
          transition-[transform,filter,background-color,border-color,box-shadow]
          duration-150 active:scale-[0.97]
          disabled:opacity-40 disabled:pointer-events-none
          ${variants[variant]} ${sizes[size]} ${className}
        `}
        {...props}
      >
        {children}
      </button>
    );
  }
);
