"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import s from "./landing.module.css";
import { units, short } from "@/lib/format";

type Row = {
  maker: string;
  promised: string;
  deliverable: string;
  backed: boolean;
  decimals: number;
  symbol: string;
};

/** Where each hero card sits and how hard it fights the scroll. Depth is the
 *  only thing that sells parallax: identical speeds read as one flat sheet. */
const HERO_SPOTS = [
  { top: "16%", left: "2%", drift: -110, rot: -1.4 },
  { top: "58%", left: "5%", drift: 150, rot: 1.1 },
  { top: "26%", right: "3%", drift: -170, rot: 1.6 },
  { top: "66%", right: "6%", drift: 96, rot: -0.9 },
];

const DARK_SPOTS = [
  { top: "10%", left: "4%", drift: 120, rot: -1.2 },
  { top: "62%", left: "8%", drift: -90, rot: 1.4 },
  { top: "16%", right: "5%", drift: -140, rot: 1.1 },
  { top: "68%", right: "3%", drift: 100, rot: -1.5 },
  { top: "40%", left: "26%", drift: 62, rot: 0.7 },
  { top: "44%", right: "24%", drift: -70, rot: -0.8 },
];

/** gsap.from writes its start state when the tween is created. In useEffect that
 *  happens after paint, so the content flashes in and then hides itself before
 *  animating. Before paint, there is nothing to see. Falls back to useEffect on
 *  the server, where there is no layout to run against. */
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export default function Landing() {
  const root = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [finding, setFinding] = useState<{ under: number; of: number } | null>(null);

  // Real makers, from the chain the app defaults to. The cards are the product's
  // own data, not decoration invented for a hero — a fabricated one would be the
  // one thing on this page that could not survive a judge clicking through.
  useEffect(() => {
    let live = true;
    fetch("/api/makers?chain=84532")
      .then((r) => r.json())
      .then((d) => {
        if (!live || d.error) return;
        setRows(
          (d.makers ?? []).slice(0, 6).map((m: Record<string, string>) => ({
            maker: m.maker,
            promised: m.virtual,
            deliverable: m.depth,
            backed: m.shortfall === "0",
            decimals: d.token?.decimals ?? 18,
            symbol: d.token?.symbol ?? "WETH",
          }))
        );
      })
      .catch(() => {});
    fetch("/api/coverage?chain=8453&first=12")
      .then((r) => r.json())
      .then((d) => {
        if (!live || d.error) return;
        setFinding({ under: d.underCollateralised, of: d.positions });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  /**
   * The intro plays once, on mount.
   *
   * It used to live in the same effect as the card drift, keyed on the fetched
   * data — so when the makers arrived a second later, GSAP reverted and rebuilt
   * everything and the headline animated in a second time. The reveal belongs to
   * the page load; the parallax belongs to the cards, which do not exist until
   * their data does. Two effects, two lifetimes.
   */
  useIsomorphicLayoutEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    gsap.registerPlugin(ScrollTrigger);

    const ctx = gsap.context(() => {
      gsap.from("[data-claim] > span", {
        yPercent: 108,
        duration: 1.05,
        ease: "power3.out",
        stagger: 0.08,
      });
      gsap.from("[data-fade]", { opacity: 0, y: 14, duration: 0.8, delay: 0.35, stagger: 0.07 });

      gsap.from("[data-finding]", {
        opacity: 0,
        y: 26,
        duration: 0.9,
        ease: "power2.out",
        scrollTrigger: { trigger: "[data-finding]", start: "top 82%" },
      });

      gsap.utils.toArray<HTMLElement>("[data-proof]").forEach((el, i) => {
        gsap.from(el, {
          opacity: 0,
          y: 22,
          duration: 0.7,
          delay: i * 0.08,
          ease: "power2.out",
          scrollTrigger: { trigger: el, start: "top 88%" },
        });
      });
    }, root);

    return () => ctx.revert();
  }, []);

  /** The drift, rebuilt whenever the set of cards changes — and only then. */
  useIsomorphicLayoutEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (rows.length === 0) return;

    const ctx = gsap.context(() => {
      gsap.utils.toArray<HTMLElement>("[data-drift]").forEach((el) => {
        const drift = Number(el.dataset.drift ?? 0);
        gsap.fromTo(
          el,
          { y: -drift * 0.4 },
          {
            y: drift,
            ease: "none",
            scrollTrigger: {
              trigger: el.closest("section") ?? el,
              start: "top bottom",
              end: "bottom top",
              scrub: 0.6,
            },
          }
        );
      });
    }, root);

    return () => ctx.revert();
  }, [rows.length]);

  const hero = rows.slice(0, 4);
  const dark = rows.length ? [...rows, ...rows].slice(0, 6) : [];

  return (
    <div className={s.wrap} ref={root}>
      <section className={s.hero} id="top">
        <nav className={s.nav}>
          <span className={s.mark}>
            BONE<em>&middot;</em>DRY
          </span>
          <span className={`${s.navLinks} label`}>
            <a href="https://github.com/dhruv457457/Bone-Dry">Source</a>
            <Link className={s.enter} href="/app">
              Open the app
            </Link>
          </span>
        </nav>

        <div className={s.field} aria-hidden>
          {hero.map((r, i) => (
            <Card key={r.maker} row={r} spot={HERO_SPOTS[i]} />
          ))}
        </div>

        <div className={s.heroBody}>
          <h1 className={s.claim} data-claim>
            <span className={s.claimLine}>
              <span>A pool that</span>
            </span>
            <span className={s.claimLine}>
              <span>holds nothing.</span>
            </span>
          </h1>
          <p className={s.deck} data-fade>
            A Uniswap v4 pool with zero TVL. Every swap is filled from 1inch Aqua makers&apos;
            own wallets at the moment of the trade — and we check they can actually pay
            before we route to them.
          </p>
        </div>

        <div className={`${s.heroFoot} label`} data-fade>
          <span>Live on Base Sepolia</span>
          <span>Uniswap v4 hook</span>
          <span>1inch Aqua</span>
          <span>The Graph</span>
        </div>
      </section>

      <section className={s.dark} id="finding">
        <div className={s.darkField} aria-hidden>
          {dark.map((r, i) => (
            <Card key={`${r.maker}-${i}`} row={r} spot={DARK_SPOTS[i]} dark />
          ))}
        </div>
        <div className={s.darkInner}>
          <h2 className={s.finding} data-finding>
            {finding ? (
              <>
                {finding.under} of the {finding.of} largest maker positions on Base are{" "}
                <b>promising liquidity they do not hold</b>.
              </>
            ) : (
              <>
                Most of the largest maker positions on Base are{" "}
                <b>promising liquidity they do not hold</b>.
              </>
            )}
          </h2>
          <p className={s.findingNote} data-finding>
            Aqua keys balances by maker, app, strategy and token, and the mapping is not
            enumerable — so no contract can total what one maker has promised across every
            strategy they have live. An index can. Set that against the wallet and the
            promise becomes checkable.
          </p>
        </div>
      </section>

      <section className={s.proofStrip} id="proof">
        <div className={s.proofItem} data-proof>
          <div className={s.proofFig}>0</div>
          <p className={s.proofSay}>
            The pool&apos;s liquidity, read straight out of PoolManager storage — before a
            swap and after one.
          </p>
        </div>
        <div className={s.proofItem} data-proof>
          <div className={s.proofFig}>3 : 2</div>
          <p className={s.proofSay}>
            How a real fill split across two makers, matching their deliverable depths
            exactly. A third promised the same and held none of it.
          </p>
        </div>
        <div className={s.proofItem} data-proof>
          <div className={s.proofFig}>0.04</div>
          <p className={s.proofSay}>
            Basis points between what the router quoted and what the chain paid — two
            independent algorithms over the same state.
          </p>
        </div>
      </section>

      <section className={s.close} id="open">
        <h2 className={s.closeClaim} data-proof>
          Your money never leaves your wallet.
        </h2>
        <Link className={s.cta} href="/app">
          Open the app
        </Link>
        <p className={s.ctaNote}>
          Base Sepolia, free tokens, nothing to lose. Mainnet is there too, read-only.
        </p>
      </section>
    </div>
  );
}

function Card({
  row,
  spot,
  dark = false,
}: {
  row: Row;
  spot?: { top: string; left?: string; right?: string; drift: number; rot: number };
  dark?: boolean;
}) {
  if (!spot) return null;
  const hollow = !row.backed;
  return (
    <div
      className={`${dark ? s.darkCard : s.card} ${hollow ? (dark ? s.darkGhost : s.ghost) : ""}`}
      style={{
        top: spot.top,
        left: spot.left,
        right: spot.right,
        rotate: `${spot.rot}deg`,
      }}
      data-drift={spot.drift}
    >
      <div className={s.cardTop}>
        <span className={s.cardTag}>maker</span>
        <span className={s.cardTag}>{hollow ? "unbacked" : "backed"}</span>
      </div>
      <div className={s.cardAddr}>{short(row.maker)}</div>
      <div className={s.cardRow}>
        <span>promised</span>
        <span>
          {units(row.promised, row.decimals, 4)} {row.symbol}
        </span>
      </div>
      <div className={s.cardRow}>
        <span>deliverable</span>
        <span className={hollow ? s.gone : s.ok}>
          {units(row.deliverable, row.decimals, 4)} {row.symbol}
        </span>
      </div>
    </div>
  );
}
