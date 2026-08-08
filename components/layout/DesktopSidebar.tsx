"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutGrid, Camera } from "lucide-react";
import { BrandWordmark } from "@/components/ui/BrandLogo";
import { COLLECTIONS_HREF, rememberCollectionsOpen } from "@/lib/appNavigation";

const NAV = [
  { href: COLLECTIONS_HREF, label: "COLLECTIONS", icon: LayoutGrid, exact: true },
  { href: "/record", label: "CAMERA", icon: Camera, exact: false },
];

export function DesktopSidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden md:flex flex-col w-60 shrink-0 border-r border-white/8 bg-screen/60 p-5 gap-8">
      {/* Brand */}
      <Link href="/" className="flex items-center gap-3">
        <BrandWordmark />
      </Link>

      {/* Nav */}
      <nav className="flex flex-col gap-1.5">
        {NAV.map(({ href, label, icon: Icon, exact }) => {
          const routePath = href.split("?")[0];
          const active = exact
            ? pathname === routePath
            : pathname.startsWith(routePath);
          return (
            <Link
              key={href}
              href={href}
              onClick={() => {
                if (label === "COLLECTIONS") rememberCollectionsOpen(true);
              }}
              className={`flex items-center gap-3 px-3 py-3 rounded-2xl transition-colors font-[family-name:var(--font-display)] text-sm ${
                active
                  ? "text-screen bg-banana"
                  : "text-cream/70 hover:text-cream hover:bg-white/5"
              }`}
            >
              <Icon size={18} strokeWidth={2.5} />
              {label}
            </Link>
          );
        })}
      </nav>

      <p className="mt-auto text-cream/30 text-xs leading-relaxed">
        A community tool. Artwork & trademarks belong to their respective owners.
      </p>
    </aside>
  );
}
