"use client";

import dynamic from "next/dynamic";
import { BlinkingCursor } from "@/components/ui/BlinkingCursor";

// The AR view pulls in MediaPipe + browser-only APIs — never render it on the
// server / during static prerender.
const RecordView = dynamic(
  () => import("@/components/ar/RecordView").then((m) => m.RecordView),
  {
    ssr: false,
    loading: () => (
      <div className="min-h-[70vh] flex items-center justify-center">
        <BlinkingCursor label="BOOTING" className="text-xs" />
      </div>
    ),
  }
);

export default function RecordPage() {
  return <RecordView />;
}
