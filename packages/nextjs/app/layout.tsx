import type { Metadata } from "next";
import { Suspense, type ReactNode } from "react";
import { Providers } from "@/components/Providers";
import { SiteHeader } from "@/components/SiteHeader";
import "@fontsource-variable/inter";
import "@fontsource-variable/newsreader/wght.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "RWA Credit Rail",
  description:
    "Bilateral HBAR financing against Hedera ATS securities with partition holds, HSS maturity settlement, and Mirror-verifiable evidence.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <Suspense fallback={null}>
            <SiteHeader />
          </Suspense>
          {children}
          <footer>
            <span>RWA Credit Rail</span>
            <span>
              Verified Hedera testnet lifecycle. Invariant and Harness gated. No
              independent production audit. Never expose operator keys.
            </span>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
