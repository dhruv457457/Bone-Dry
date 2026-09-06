import type { Metadata } from "next";
import "lenis/dist/lenis.css";
import "./globals.css";
import Motion from "./ui/Motion";
import Web3 from "./ui/Web3";

export const metadata: Metadata = {
  title: { default: "Bone Dry", template: "%s · Bone Dry" },
  description:
    "A Uniswap v4 pool that holds nothing. Every swap is filled from 1inch Aqua makers' own wallets — and we check they can actually pay before routing to them.",
  applicationName: "Bone Dry",
  authors: [{ name: "dhruv457457", url: "https://github.com/dhruv457457" }],
  metadataBase: new URL("https://bone-dry.vercel.app"),
  openGraph: {
    title: "Bone Dry — a pool that holds nothing",
    description:
      "Zero TVL. Every fill drawn from 1inch Aqua maker wallets at the moment of the trade. Seven of the twelve largest maker positions on Base promise liquidity they do not hold.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Bone Dry — a pool that holds nothing",
    description:
      "A Uniswap v4 hook that fills from 1inch Aqua wallets, and checks the maker can pay before routing to them.",
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>
        <Web3>
          <Motion>{children}</Motion>
        </Web3>
      </body>
    </html>
  );
}
