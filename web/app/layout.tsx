import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Bone Dry",
  description:
    "A Uniswap v4 pool that holds no liquidity. Fills are drawn from 1inch Aqua maker wallets at swap time.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
