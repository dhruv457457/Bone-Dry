import { IBM_Plex_Mono, Playfair_Display, Spectral } from "next/font/google";

/**
 * The /app surface's three faces, and the reason this layout exists at all.
 *
 * next/font scopes a face to the component that uses it, so declaring them here
 * rather than in the root layout is what keeps them off the landing page — which
 * has its own serif and its own palette, and is deliberately not being brought
 * in line with this one.
 *
 * Exposed as CSS variables rather than classNames because the surface is styled
 * from a CSS module (`app.module.css`) that needs to name them in rules.
 */
const display = Playfair_Display({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-display",
  display: "swap",
});

const body = Spectral({
  subsets: ["latin"],
  weight: ["300", "400", "500"],
  variable: "--font-body",
  display: "swap",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <div className={`${display.variable} ${body.variable} ${mono.variable}`}>{children}</div>;
}
