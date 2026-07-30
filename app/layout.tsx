import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import Script from "next/script";
import { GradientField } from "@/components/ui/GradientField";
import { AppShell } from "@/components/layout/AppShell";
import { analyticsEnabled, UMAMI_SRC, UMAMI_WEBSITE_ID } from "@/lib/analytics";

// Clash Display (display) + Satoshi (body) — variable TTFs, self-hosted.
const clash = localFont({
  src: "./fonts/ClashDisplay-Variable.ttf",
  weight: "200 700",
  style: "normal",
  variable: "--font-clash",
  display: "swap",
});

const satoshi = localFont({
  src: "./fonts/Satoshi-Variable.ttf",
  weight: "300 900",
  style: "normal",
  variable: "--font-satoshi",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://switchsol.xyz/"),
  title: "SWITCH — Wear the Culture",
  description:
    "Wear any PFP as a live face mask, snap a photo or record a clip, and share it. Solana & Ethereum collections. Nothing leaves your device.",
  openGraph: {
    title: "SWITCH — Wear the Culture",
    description:
      "Wear any PFP as a live face mask, snap or record, and share. On-device.",
    type: "website",
  },
  // Favicon is auto-detected from app/icon.svg.
};

export const viewport: Viewport = {
  themeColor: "#0a0b0d",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${clash.variable} ${satoshi.variable} h-full`}>
      <body className="min-h-full">
        {/* Cookie-less, aggregate-only, and absent entirely unless configured
            at build time — see lib/analytics.ts and the privacy page. */}
        {analyticsEnabled && (
          <Script
            src={UMAMI_SRC}
            data-website-id={UMAMI_WEBSITE_ID}
            strategy="afterInteractive"
          />
        )}
        <GradientField />
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
