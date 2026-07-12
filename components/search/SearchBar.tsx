"use client";

import { useEffect, useRef } from "react";
import { PixelInput } from "@/components/ui/PixelInput";

interface SearchBarProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  maxDigits: number;
}

/** Desktop search input — digits only, autofocus, Enter to confirm. */
export function SearchBar({
  value,
  onChange,
  onSubmit,
  maxDigits,
}: SearchBarProps) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <PixelInput
      ref={ref}
      inputMode="numeric"
      pattern="[0-9]*"
      placeholder="TYPE #"
      value={value}
      onChange={(e) => {
        const digits = e.target.value.replace(/\D/g, "").slice(0, maxDigits);
        onChange(digits);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSubmit();
      }}
      aria-label="Token number"
    />
  );
}
