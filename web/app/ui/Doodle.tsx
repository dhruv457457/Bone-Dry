"use client";

import { useRef } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import s from "./landing.module.css";
import { useIsomorphicLayoutEffect } from "./useIsomorphicLayoutEffect";

/**
 * The hero doodle: a figure straining to hold a rope taut between two cliffs.
 *
 * It is the headline drawn rather than written. He is holding the two halves of
 * a promise together by main strength and nothing else; scroll, and the ground
 * walks away from under both ends, the rope goes slack, and he is simply not
 * there any more. Nothing was ever holding it up.
 *
 * One SVG rather than five, because the rope has to meet the cliffs and meet the
 * hands at every viewport width, and separately positioned images cannot promise
 * that. `meet` keeps the whole scene in frame; the plateau lines run far past the
 * viewBox on both sides and the svg does not clip, so the ground still reaches
 * the screen edges on a monitor much wider than the drawing.
 */

/* The two rope halves, taut and slack. GSAP tweens the `d` attribute by
   interpolating the numbers in it, which only works while the two strings hold
   the same commands in the same order — so these four must stay one M and one C
   apiece. The slack pair also walks the hand ends inward and down, which is what
   makes the two halves meet in a single sag once he lets go. */
const ROPE = {
  leftTaut: "M 384 640 C 452 632, 540 630, 612 636",
  leftSlack: "M 384 640 C 452 722, 566 756, 664 752",
  rightTaut: "M 828 636 C 900 630, 988 632, 1056 640",
  rightSlack: "M 776 752 C 874 756, 988 722, 1056 640",
};

export default function Doodle() {
  const root = useRef<SVGSVGElement>(null);

  useIsomorphicLayoutEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const svg = root.current;
    if (!svg) return;
    gsap.registerPlugin(ScrollTrigger);

    const ctx = gsap.context(() => {
      // A slow lean, so he reads as holding something rather than posing next to
      // it. Pivoted at his feet — a figure under load bends from the ground.
      gsap.to("[data-fig]", {
        rotation: 1.2,
        svgOrigin: "720 736",
        duration: 2.6,
        ease: "sine.inOut",
        yoyo: true,
        repeat: -1,
      });

      const tl = gsap.timeline({
        scrollTrigger: {
          trigger: svg.closest("section") ?? svg,
          start: "top top",
          end: "bottom top",
          scrub: 0.8,
        },
      });

      // The rope gives first, then he goes, then the ground leaves. Order is the
      // whole joke: if the cliffs moved first the rope would look pulled apart
      // rather than never taut.
      tl.to("[data-rope-l]", { attr: { d: ROPE.leftSlack }, duration: 0.55, ease: "none" }, 0)
        .to("[data-rope-r]", { attr: { d: ROPE.rightSlack }, duration: 0.55, ease: "none" }, 0)
        .to("[data-fig]", { opacity: 0, y: 30, duration: 0.4, ease: "power1.in" }, 0.14)
        .to("[data-cliff-l]", { x: -560, duration: 0.72, ease: "none" }, 0.3)
        .to("[data-cliff-r]", { x: 560, duration: 0.72, ease: "none" }, 0.3)
        .to("[data-rope]", { opacity: 0, duration: 0.34, ease: "none" }, 0.44);
    }, svg);

    return () => ctx.revert();
  }, []);

  return (
    <svg
      ref={root}
      className={s.doodle}
      viewBox="0 0 1440 760"
      preserveAspectRatio="xMidYMax meet"
      fill="none"
      aria-hidden
      focusable="false"
    >
      {/* ── the ground, left and right ─────────────────────────────────── */}
      <g className={s.terra} data-cliff-l>
        <path d="M -700 592 C -380 597, -80 588, 176 594 C 302 597, 356 606, 384 648 C 406 680, 402 722, 396 760" />
        {/* a few strokes down the face, so the edge reads as earth and not a wire */}
        <path className={s.hatch} d="M 392 672 L 366 706" />
        <path className={s.hatch} d="M 384 700 L 358 738" />
        <path className={s.hatch} d="M 300 600 L 288 620" />
      </g>

      <g className={s.terra} data-cliff-r>
        <path d="M 2140 592 C 1820 597, 1520 588, 1264 594 C 1138 597, 1084 606, 1056 648 C 1034 680, 1038 722, 1044 760" />
        <path className={s.hatch} d="M 1048 672 L 1074 706" />
        <path className={s.hatch} d="M 1056 700 L 1082 738" />
        <path className={s.hatch} d="M 1140 600 L 1152 620" />
      </g>

      {/* ── the rope ───────────────────────────────────────────────────── */}
      <g className={s.rope} data-rope>
        <path data-rope-l d={ROPE.leftTaut} />
        <path data-rope-r d={ROPE.rightTaut} />
      </g>

      {/* ── the one holding it ─────────────────────────────────────────── */}
      <g className={s.fig} data-fig>
        <ellipse cx="720" cy="520" rx="27" ry="29" />
        <path className={s.face} d="M 711 513 L 711 515" />
        <path className={s.face} d="M 730 513 L 730 515" />
        <path className={s.face} d="M 707 531 C 714 540, 727 540, 734 530" />
        <path d="M 720 549 C 721 556, 720 561, 720 567" />
        <path d="M 720 567 C 723 605, 718 640, 721 668" />
        {/* arms out to the rope, with the bicep the drawing insists on */}
        <path d="M 720 579 C 690 581, 650 607, 612 636" />
        <path d="M 720 579 C 750 581, 790 607, 828 636" />
        <path className={s.bulge} d="M 703 583 C 694 573, 678 577, 673 592" />
        <path className={s.bulge} d="M 737 583 C 746 573, 762 577, 767 592" />
        <path d="M 721 668 C 707 692, 691 714, 678 737" />
        <path d="M 721 668 C 735 692, 751 714, 764 737" />
      </g>
    </svg>
  );
}
