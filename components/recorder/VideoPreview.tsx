"use client";

interface VideoPreviewProps {
  url: string;
  className?: string;
}

/** Looping autoplay playback of the recorded clip. */
export function VideoPreview({ url, className = "" }: VideoPreviewProps) {
  return (
    <video
      src={url}
      autoPlay
      loop
      playsInline
      controls
      className={`w-full h-full object-contain bg-screen ${className}`}
    />
  );
}
