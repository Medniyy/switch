import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Use | SWITCH",
  description: "Terms governing use of the SWITCH camera experience.",
};

export default function TermsOfUse() {
  return (
    <main className="max-w-3xl mx-auto px-5 py-10 md:py-16">
      <article className="pixel-border-banana bg-grid p-5 md:p-8">
        <p className="font-[family-name:var(--font-display)] text-banana text-xs tracking-[0.2em]">
          SWITCH
        </p>
        <h1 className="font-[family-name:var(--font-display)] font-semibold text-cream text-2xl md:text-4xl leading-tight mt-3">
          Terms of Use
        </h1>
        <p className="text-cream/55 text-base mt-2">Last updated: July 2, 2026</p>

        <div className="mt-8 space-y-8 text-cream/80 text-lg leading-relaxed">
          <Section title="Acceptance">
            By using SWITCH, you agree to these Terms. If you do not agree, do not
            use the app.
          </Section>

          <Section title="A community tool — not affiliated">
            SWITCH is an independent, community-made tool. It is not affiliated
            with, endorsed by, sponsored by, or officially connected to any of the
            NFT collections, marketplaces, or brands it can display. All
            collection names, logos, artwork, and related trademarks are the
            property of their respective owners, and every right to that artwork
            remains fully with them. SWITCH only displays publicly available NFT
            images that you choose to wear; it claims no ownership of that artwork
            and grants you no rights to it. The app is offered in good faith, free
            of charge, with no advertising, nothing for sale, and no in-app
            purchases. Any rights holder who would like a change or removal can
            reach us at the email below.
          </Section>

          <Section title="The service">
            SWITCH lets you choose a collection, select a public NFT image by its
            number, apply it as a live camera effect, capture a photo or clip,
            and share or save it locally. Features may change, pause, or be
            discontinued.
          </Section>

          <Section title="Your content and conduct">
            You are responsible for the photos and clips you create or share. You
            must have the rights and permissions needed for the people, audio,
            images, trademarks, and other material in your capture. Do not use
            SWITCH for unlawful, deceptive, abusive, infringing, or harmful
            content.
          </Section>

          <Section title="Intellectual property">
            SWITCH&apos;s original software, interface, and branding are protected
            by applicable intellectual-property laws. Third-party names, images,
            and marks belong to their respective owners. SWITCH does not grant
            ownership of third-party NFT artwork.
          </Section>

          <Section title="Third-party services">
            Content gateways, static hosts, and any destination you share to (for
            example X) are independent services governed by their own terms. SWITCH
            is not responsible for their availability, content, security, or
            actions.
          </Section>

          <Section title="No financial service">
            SWITCH is a creative camera tool. It is not a wallet, exchange, broker,
            investment product, or financial adviser. Nothing in the app is
            financial advice or a guarantee of any token&apos;s value.
          </Section>

          <Section title="Disclaimer">
            SWITCH is provided &quot;as is&quot; and &quot;as available.&quot; To
            the maximum extent permitted by law, we disclaim warranties of
            merchantability, fitness for a particular purpose, non-infringement,
            uninterrupted operation, and error-free results.
          </Section>

          <Section title="Limitation of liability">
            To the maximum extent permitted by law, SWITCH&apos;s operator will not
            be liable for indirect, incidental, special, consequential, or
            punitive damages, or for loss of content, data, profits, or
            opportunities arising from use of the app or third-party services.
          </Section>

          <Section title="Changes and contact">
            We may update these Terms as the app changes. Continued use after an
            update means you accept the revised Terms. Questions can be sent to{" "}
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
