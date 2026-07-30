import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy | SWITCH",
  description:
    "How SWITCH handles camera, microphone, and photo/video data — everything stays on your device.",
};

export default function PrivacyPolicy() {
  return (
    <main className="max-w-3xl mx-auto px-5 py-10 md:py-16">
      <article className="pixel-border-banana bg-grid p-5 md:p-8">
        <p className="font-[family-name:var(--font-display)] text-banana text-xs tracking-[0.2em]">
          SWITCH
        </p>
        <h1 className="font-[family-name:var(--font-display)] font-semibold text-cream text-2xl md:text-4xl leading-tight mt-3">
          Privacy Policy
        </h1>
        <p className="text-cream/55 text-base mt-2">Last updated: July 2, 2026</p>

        <div className="mt-8 space-y-8 text-cream/80 text-lg leading-relaxed">
          <Section title="Overview">
            SWITCH is a camera experience that lets you wear an NFT PFP as a live
            face mask and capture a photo or clip. There is no account system, no
            advertising network, no database, and no upload backend. Your camera
            feed, microphone, and captures are processed entirely on your device.
          </Section>

          <Section title="A community tool">
            SWITCH is an independent, community-made tool. It is not affiliated
            with, endorsed by, or connected to any of the NFT collections it can
            display. All artwork, names, and trademarks belong to their respective
            owners; SWITCH only renders publicly available collection art you
            choose to wear. It is offered in good faith, with no in-app purchases
            and no sale of your data.
          </Section>

          <Section title="Camera, microphone, and captures">
            Camera and microphone input is used only on your device to create the
            live effect and your capture. A finished photo or clip is held
            temporarily in your browser and leaves SWITCH only when you choose to
            share or save it. We never receive, store, or transmit your camera
            feed, microphone, or captures.
          </Section>

          <Section title="Local storage">
            SWITCH may store small preferences in your browser — whether you have
            seen the intro, and the token numbers you recently wore — so the app
            behaves nicely on your next visit. This stays on your device; we do
            not receive it.
          </Section>

          <Section title="Analytics">
            We plan to use{" "}
            <a
              className="text-banana underline"
              href="https://umami.is"
              target="_blank"
              rel="noopener noreferrer"
            >
              Umami
            </a>
            , a privacy-friendly, cookie-less analytics tool, purely to understand
            aggregate usage and improve the app. It does not collect personal
            information and does not track you across sites.
            <br />
            <br />
            We record page views and one custom event: which collection was
            opened. That event carries the collection name only — never the
            specific NFT you picked, never a wallet address, and never anything
            about your camera, photos, or the masks you make. Your approximate
            country is derived from your IP address so we can show how many
            countries SWITCH is used in; the IP address itself is not stored by
            us. Some of these totals — visitors, countries, and the most-opened
            collections — are displayed publicly on the site as aggregate counts
            that cannot be traced back to any individual.
          </Section>

          <Section title="Network requests and third parties">
            The app loads its interface, collection art, and on-device
            face-tracking model from its static host and public content gateways.
            Those hosts, image gateways, and any service you choose to share to
            (for example X) may process technical information under their own
            privacy policies.
          </Section>

          <Section title="Permissions">
            SWITCH requests camera and microphone access only for the live effect
            and recording. You can revoke these in your browser or OS settings at
            any time; the relevant features simply stop working.
          </Section>

          <Section title="Children">
            SWITCH is not directed to children under 13 and does not knowingly
            collect personal information from children.
          </Section>

          <Section title="Changes and contact">
            We may update this policy as the app evolves. Questions can be sent to{" "}
            <a className="text-banana underline" href="mailto:athmedia21@gmail.com">
              athmedia21@gmail.com
            </a>
            .
          </Section>
        </div>
      </article>
    </main>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="font-[family-name:var(--font-display)] text-banana text-sm font-medium mb-2">
        {title}
      </h2>
      <p>{children}</p>
    </section>
  );
}
