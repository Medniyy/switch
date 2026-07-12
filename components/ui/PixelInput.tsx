"use client";

import { InputHTMLAttributes, forwardRef } from "react";

/**
 * Pixel-styled text input. Big VT323 numerals, chunky border, banana
 * focus ring handled globally.
 */
export const PixelInput = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(function PixelInput({ className = "", ...props }, ref) {
  return (
    <input
      ref={ref}
      className={`
        bg-screen text-cream pixel-border
        font-[family-name:var(--font-body)]
        text-3xl px-4 py-3 w-full
        placeholder:text-cream/30
        ${className}
      `}
      {...props}
    />
  );
});
