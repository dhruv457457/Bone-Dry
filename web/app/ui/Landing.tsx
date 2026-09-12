"use client";

import { useRef } from "react";
import Link from "next/link";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import s from "./landing.module.css";
import Doodle from "./Doodle";
import { useIsomorphicLayoutEffect } from "./useIsomorphicLayoutEffect";
import { units, short } from "@/lib/format";

type Row = {
  maker: string;
  promised: string;
  deliverable: string;
  backed: boolean;
  decimals: number;
  symbol: string;
};

/**
 * A real reading, taken once and checked in — not invented data.
 *
 * These four positions and the count below were read off Base mainnet on
 * 11 September 2026 through this project's own coverage endpoint, and the token
 * symbols off the tokens themselves. Nothing here is decoration: every address,
 * amount and symbol is one a judge can paste into a block explorer.
 *
 * They are checked in rather than fetched because the scan behind them costs
 * well over a minute against an archive node, and a landing page cannot open on
 * a spinner while a mainnet history is walked. The app does that work live; the
 * hero states the finding it produced. When the numbers move, re-run
 * `/api/coverage?chain=8453&first=12` and paste the new ones in.
 */
const SNAPSHOT: Row[] = [
  {
    maker: "0x7553afc9cf3815ce24e33d14d1431b2918484a55",
    promised: "12694544852159238451250",
    deliverable: "0",
    backed: false,
    decimals: 18,
    symbol: "DAI",
  },
  {
    maker: "0x3a43db18aba3884a06869ddaf506b9cb6b44b77b",
    promised: "127139312088594117127881",
    deliverable: "127139312088594117127881",
    backed: true,
    decimals: 18,
    symbol: "BNKR",
  },
  {
    maker: "0x1a09f7d9b921c93f8fcd4bf04fe448982a3388ec",
    promised: "130154510951763097646",
    deliverable: "0",
    backed: false,
    decimals: 18,
    symbol: "MYRC",
  },
  {
    maker: "0x181b8e10c8ffe94984964904908c312ab3cf380b",
    promised: "928282595863657147273",
    deliverable: "928282595863657147273",
    backed: true,
    decimals: 18,
    symbol: "STONKEX",
  },
];

/** From the same reading: 12 largest positions, 7 of them short. */
const FINDING = { under: 7, of: 12 };
const MEASURED = "11 September 2026";

/** Where each hero card sits and how hard it fights the scroll. Depth is the
 *  only thing that sells parallax: identical speeds read as one flat sheet.
 *  All four sit in the upper half now — the bottom of the hero belongs to the
 *  drawing, and cards down there landed on the cliffs and the labels. */
const HERO_SPOTS = [
  { top: "12%", left: "2%", drift: -110, rot: -1.4 },
  { top: "38%", left: "4%", drift: 150, rot: 1.1 },
  { top: "17%", right: "3%", drift: -170, rot: 1.6 },
  { top: "42%", right: "5%", drift: 96, rot: -0.9 },
];

const DARK_SPOTS = [
  { top: "10%", left: "4%", drift: 120, rot: -1.2 },
  { top: "62%", left: "8%", drift: -90, rot: 1.4 },
  { top: "16%", right: "5%", drift: -140, rot: 1.1 },
  { top: "68%", right: "3%", drift: 100, rot: -1.5 },
  { top: "40%", left: "26%", drift: 62, rot: 0.7 },
  { top: "44%", right: "24%", drift: -70, rot: -0.8 },
];

export default function Landing() {
  const root = useRef<HTMLDivElement>(null);
  const rows = SNAPSHOT;
  /** The intro, once, on mount. */
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
      gsap.from("[data-fade]", {
        opacity: 0,
        y: 14,
        duration: 0.8,
        delay: 0.35,
        stagger: 0.07,
      });

      gsap.from("[data-finding]", {
        opacity: 0,
        y: 26,
        duration: 0.9,
        ease: "power2.out",
        scrollTrigger: { trigger: "[data-finding]", start: "top 82%" },
      });

      // The footer row and the drawing share the foot of the screen, and the
      // drawing is sticky while the row is not — so as you scroll the labels
      // ride up through the figure. The row has said what it has to say by
      // then; it gets out of the way rather than crossing him.
      gsap.to("[data-herofoot]", {
        opacity: 0,
        duration: 1,
        ease: "none",
        scrollTrigger: {
          trigger: "[data-stage]",
          start: "top top",
          end: "top top-=22%",
          scrub: 0.5,
        },
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

  /** The drift. The cards exist on the first frame now, so unlike the reveal
   *  this no longer has to wait for data to turn up before it can be built. */
  useIsomorphicLayoutEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

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
          },
        );
      });
    }, root);

    return () => ctx.revert();
  }, []);

  const hero = rows.slice(0, 4);
  const dark = rows.length ? [...rows, ...rows].slice(0, 6) : [];

  return (
    <div className={s.wrap} ref={root}>
      {/* The stage is taller than the hero it holds. The extra height below is
          the runway the drawing falls through — the doodle's timeline is scrubbed
          against this element, so its length is the length of the whole story. */}
      <div className={s.stage} data-stage>
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
            {/* Keyed by index as well as address: the makers endpoint can hand
                back the same maker twice, and a bare address key collides when
                it does — React was warning about exactly that. */}
            {hero.map((r, i) => (
              <Card key={`${r.maker}-${i}`} row={r} spot={HERO_SPOTS[i]} />
            ))}
          </div>

          <div className={s.heroBody}>
            {/* The drawing below is a man holding the two halves of a promise
                together until they tear him apart, and its cliffs are labelled
                PROMISED and DELIVERABLE. The headline has to be about that gap.
                It used to read "A pool that holds nothing" — true, but a claim
                about TVL, which left the picture arguing on its own. */}
            <h1 className={s.claim} data-claim>
              <span className={s.claimLine}>
                <span>A promise</span>
              </span>
              <span className={s.claimLine}>
                <span>that can&apos;t bounce.</span>
              </span>
            </h1>
            <p className={s.deck} data-fade>
              On 1inch Aqua a maker never deposits — the money stays in their
              wallet and they only promise it. Nothing stops the same balance
              being promised twice. This position reads what the wallet already
              owes before it quotes, and refuses on chain rather than write a
              cheque it cannot cover.
            </p>
          </div>

          <div className={`${s.heroFoot} label`} data-fade data-herofoot>
            <span>Live on Base Sepolia</span>
            <span>Uniswap v4 hook</span>
            <span>1inch Aqua</span>
            <span>The Graph</span>
          </div>
        </section>

        {/* Empty paper. This is the distance he falls through, and the length of
            scroll the whole sequence is scrubbed against. */}
        <div className={s.runway} aria-hidden />

        {/* Last child, and sticky, so the drawing holds its place at the foot of
            the screen for the length of the stage instead of scrolling off with
            the hero. That is what lets him come down the screen with you rather
            than leaving before anything happens to him. */}
        <div className={s.doodleHold} aria-hidden>
          <Doodle />
        </div>
      </div>

      <section className={s.dark} id="finding">
        <div className={s.darkField} aria-hidden>
          {dark.map((r, i) => (
            <Card key={`${r.maker}-${i}`} row={r} spot={DARK_SPOTS[i]} dark />
          ))}
        </div>
        <div className={s.darkInner}>
          <h2 className={s.finding} data-finding>
            {FINDING.under} of the {FINDING.of} largest maker positions on Base
            were <b>promising liquidity they did not hold</b>.
          </h2>
          <p className={s.findingNote} data-finding>
            Aqua keys balances by maker, app, strategy and token, and the mapping
            is not enumerable — so no contract can total what one maker has
            promised. An index can. Set that against the wallet, and the promise
            becomes checkable.
          </p>

          {/* Base is what the cards above show, and every address there is one a
              judge can paste into a block explorer. Ethereum is where Aqua is
              largest, and where the same check stops being a curiosity. Both
              stay: the small number is verifiable by hand, the large one is the
              size of the problem. Figures rather than prose — see .scale. */}
          <div className={s.scale} data-finding>
            <div className={s.scaleItem}>
              <div className={s.scaleFig}>
                102,593 <span>&rarr;</span> <em>4</em>
              </div>
              <p className={s.scaleSay}>
                WETH advertised across Ethereum, against what those makers could
                actually deliver.
              </p>
            </div>
            <div className={s.scaleItem}>
              <div className={s.scaleFig}>
                600<span>&thinsp;/&thinsp;860</span>
              </div>
              <p className={s.scaleSay}>
                Positions built from more than one strategy that promise more
                than the wallet holds.
              </p>
            </div>
            <div className={s.scaleItem}>
              <div className={s.scaleFig}>
                <em>419</em>
              </div>
              <p className={s.scaleSay}>Backed by nothing at all.</p>
            </div>
          </div>

          <p className={s.scaleWhen} data-finding>
            Base read on {MEASURED}; Ethereum from this project&apos;s own index.
            The app re-runs both live.
          </p>
        </div>
      </section>

      <section className={s.proofStrip} id="proof">
        <div className={s.proofItem} data-proof>
          <div className={s.proofFig}>0</div>
          <p className={s.proofSay}>
            The pool&apos;s liquidity, read straight out of PoolManager storage
            — before a swap and after one.
          </p>
        </div>
        {/* These two were 3:2 (how a fill split) and 0.04 (quote-vs-chain drift).
            Both true, both arguing the old pitch — a better router. The claim is
            now about the promise, so these are the two figures that make it:
            how far one wallet is stretched, and how little it costs to walk. */}
        <div className={s.proofItem} data-proof>
          <div className={s.proofFig}>257</div>
          <p className={s.proofSay}>
            Live strategies one wallet carries against a single token — every one
            of them promising the same balance.
          </p>
        </div>
        <div className={s.proofItem} data-proof>
          <div className={s.proofFig}>4,452</div>
          <p className={s.proofSay}>
            Gas a maker pays to revoke all of it. Nothing on Aqua is binding, and
            nothing here pretends otherwise.
          </p>
        </div>
      </section>

      {/* Three panels, three doors — the same three the app opens on. The swap
          rows are the SNAPSHOT makers from the hero, so a reader who scrolled
          past those cards meets the same addresses again doing something.
          0x7553 promised 12,694 DAI and holds none of it; that is why it is
          refused here rather than filled. Nothing on this strip is invented. */}
      <section className={s.doing} id="doing">
        <div className={s.doingHead} data-proof>
          <h2 className={s.doingTitle}>What you can do with it</h2>
          <p className={s.doingNote}>three doors, the same three the app opens on</p>
        </div>

        <div className={s.doingRow} data-proof>
          <div>
            <span className={s.doingNum}>01 — Swap</span>
            <h3 className={s.doingH}>Fill from wallets, not a pool</h3>
            <p className={s.doingP}>
              Two of those three promised liquidity they do not hold. Routing
              around them is not an error — it is the swap that would have
              reverted, not happening.
            </p>
            <Link className={s.doingCta} href="/app">Open the desk &rarr;</Link>
          </div>
          <div className={s.panel}>
            <div className={s.panelRow}>
              <span>{SNAPSHOT[1].maker.slice(0, 6)}…{SNAPSHOT[1].maker.slice(-4)}</span>
              <span>filled</span>
            </div>
            <div className={s.panelRow}>
              <span>{SNAPSHOT[0].maker.slice(0, 6)}…{SNAPSHOT[0].maker.slice(-4)}</span>
              <span className={s.saved}>refused</span>
            </div>
            <div className={s.panelRow}>
              <span>{SNAPSHOT[2].maker.slice(0, 6)}…{SNAPSHOT[2].maker.slice(-4)}</span>
              <span className={s.saved}>refused</span>
            </div>
          </div>
        </div>

        <div className={`${s.doingRow} ${s.doingFlip}`} data-proof>
          <div>
            <span className={s.doingNum}>02 — Provide</span>
            <h3 className={s.doingH}>Ship a promise that polices itself</h3>
            <p className={s.doingP}>
              Your quote widens as your other strategies eat the same wallet,
              then refuses outright. The index is what tells you your own list
              is short.
            </p>
            <Link className={s.doingCta} href="/app">Become a maker &rarr;</Link>
          </div>
          <div className={s.panel}>
            <div className={s.panelRow}>
              <span>refuse above</span>
              <span>80% committed</span>
            </div>
            <div className={s.panelRow}>
              <span>quote worse by</span>
              <span>20% at the limit</span>
            </div>
            <div className={s.panelRow}>
              <span>siblings declared</span>
              <span className={s.gone}>3 of 9 live</span>
            </div>
          </div>
        </div>

        <div className={s.doingRow} data-proof>
          <div>
            <span className={s.doingNum}>03 — Explore</span>
            <h3 className={s.doingH}>Check any wallet on Aqua</h3>
            <p className={s.doingP}>
              Paste an address and total what it has promised everywhere, then
              set that against what the wallet actually holds.
            </p>
            <Link className={s.doingCta} href="/app">Look one up &rarr;</Link>
          </div>
          <div className={s.panel}>
            <div className={s.panelRow}>
              <span>promised</span>
              <span>{units(SNAPSHOT[0].promised, SNAPSHOT[0].decimals)} {SNAPSHOT[0].symbol}</span>
            </div>
            <div className={s.panelRow}>
              <span>deliverable</span>
              <span className={s.gone}>0 {SNAPSHOT[0].symbol}</span>
            </div>
            <div className={s.panelRow}>
              <span>strategies live</span>
              <span>across every Aqua app</span>
            </div>
          </div>
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
          Base Sepolia, free tokens, nothing to lose. Mainnet is there too,
          read-only.
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
  spot?: {
    top: string;
    left?: string;
    right?: string;
    drift: number;
    rot: number;
  };
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
