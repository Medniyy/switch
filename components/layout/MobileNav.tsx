"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutGrid, Camera } from "lucide-react";

const NAV = [
  { href: "/", label: "COLLECTIONS", icon: LayoutGrid, exact: true },
  { href: "/record", label: "CAMERA", icon: Camera, exact: false },
];

export function MobileNav() {
  const pathname = usePathname();

  return (
    <nav className="md:hidden fixed bottom-0 inset-x-0 z-50 grid grid-cols-2 glass border-t border-white/10">
      {NAV.map(({ href, label, icon: Icon, exact }) => {
        const active = exact ? pathname === href : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={`flex flex-col items-center justify-center gap-1 py-3 transition-colors ${
              active ? "text-banana" : "text-cream/50"
            }`}
          >
            <Icon size={22} strokeWidth={2.5} />
            <span className="font-[family-name:var(--font-display)] text-[10px] tracking-wide">
              {label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
