"use client";

import { useRef } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { RoughEase } from "gsap/EasePack";
import s from "./landing.module.css";
import { useIsomorphicLayoutEffect } from "./useIsomorphicLayoutEffect";

/**
 * The hero doodle: a strongman holding a rope taut between two cliffs.
 *
 * It is the headline drawn rather than written. He is holding the two halves of
 * a promise together by main strength and nothing else. Scroll, and the ground
 * walks away from under both ends — so the rope does not go slack, it goes
 * tight. He will not let go, so the slack has to come out of him: the arms
 * stretch, and stretch, and then the tension takes them off at the shoulder and
 * he drops out of frame. The promise did not fail because he stopped trying.
 *
 * The two sides are named. Everything between PROMISED and DELIVERABLE is the
 * shortfall this project measures, and the drawing is that number opening up
 * until it tears something.
 *
 * The viewBox is cropped to the drawing rather than to the hero. An empty upper
 * half in there would still be counted by `meet` and would shrink the scene to
 * nothing on a short viewport; the band it sits in is sized in CSS instead.
 *
 * One SVG rather than five, because the rope has to meet the cliffs and meet the
 * fists at every viewport width, and separately positioned images cannot promise
 * that. `meet` keeps the whole scene in frame; the ground lines run far past the
 * viewBox on both sides and the svg does not clip, so the land still reaches the
 * screen edges. That overhang has to be enormous rather than merely generous:
 * when the band is limited by its height the scene renders far narrower than the
 * viewport, and an overhang sized for the viewBox leaves a visible margin of
 * paper down each side. `.wrap` clips the x axis, so there is no cost to it.
 */

/* Each rope half at rest and at full stretch. GSAP tweens the `d` attribute by
   interpolating the numbers in it, which only works while the two strings hold
   the same commands in the same order — so these four must stay one M and one C
   apiece. The pulled pair is not a free drawing either: its outer end has to land
   where the cliff has travelled to (∓260) and its inner end where the stretched
   arm has put the fist, or the rope visibly lets go of one or the other. */
const ROPE = {
  leftTaut: "M 300 622 C 352 616, 440 618, 508 624",
  leftPulled: "M 40 622 C 150 624, 272 628, 394 632",
  rightTaut: "M 932 624 C 1000 618, 1088 616, 1140 622",
  rightPulled: "M 1046 632 C 1168 628, 1290 624, 1400 622",
};

/* Where each arm is anchored. The stretch and the tear both pivot on the
   shoulder, so the number is written once and used by both. */
const SHOULDER = { left: "653 509", right: "787 509" };

/* Limb centrelines, drawn twice: a thick ink stroke, then a paper stroke nine
   narrower over it. What survives is a limb outlined at 4.5 a side — the weight
   of every other line here — with its mass set by a number instead of by two
   freehand curves that have to stay parallel. Hand-drawing a silhouette around a
   bicep gets you a noodle; a stroke width gets you an arm, and the step down at
   each joint is what reads as the muscle. */
const WALL = 9;
const ARM_L = [
  ["M 653 502 L 641 517", 64], // delt, a ball on the shoulder
  ["M 641 517 Q 607 540, 577 566", 54], // upper arm
  ["M 577 566 Q 550 591, 523 617", 38], // forearm
] as const;
const ARM_R = [
  ["M 787 502 L 799 517", 64],
  ["M 799 517 Q 833 540, 863 566", 54],
  ["M 863 566 Q 890 591, 917 617", 38],
] as const;
const LEGS = [
  ["M 697 637 Q 684 666, 676 694", 56], // thigh
  ["M 676 694 Q 671 717, 670 740", 41], // calf
  ["M 670 740 L 641 745", 20], // foot
  ["M 743 637 Q 756 666, 764 694", 56],
  ["M 764 694 Q 769 717, 770 740", 41],
  ["M 770 740 L 799 745", 20],
] as const;

/** Ink pass then paper pass. Both in one go, because the order is load-bearing:
 *  every ink stroke has to be down before any paper stroke goes over it, or the
 *  joints keep the seam ring at each end instead of melting into one limb. */
function Tubes({ parts }: { parts: readonly (readonly [string, number])[] }) {
  return (
    <>
      <g className={s.ink}>
        {parts.map(([d, w]) => (
          <path key={d} strokeWidth={w} d={d} />
        ))}
      </g>
      <g className={s.paper}>
        {parts.map(([d, w]) => (
          <path key={d} strokeWidth={w - WALL} d={d} />
        ))}
      </g>
    </>
  );
}

/** One crater's worth of fire, drawn once and mirrored for the far summit.
 *  Four tongues rather than one: a single shape scaled as a unit reads as a
 *  pulsing blob, and fire is several things moving at different speeds. Each
 *  carries data-vflame so the flicker can be staggered per tongue, and the
 *  embers carry data-ember so they can drift up and out on their own loops. */
function Eruption() {
  return (
    <>
      <path className={s.plume} data-vflame d="M 164 524 C 158 496, 150 476, 157 450 C 167 476, 173 490, 173 508 C 172 516, 168 520, 166 526 Z" />
      <path className={s.plume} data-vflame d="M 195 524 C 198 500, 204 482, 199 456 C 191 480, 185 494, 185 510 C 185 517, 190 521, 192 526 Z" />
      <path className={s.plume} data-vflame d="M 178 526 C 170 486, 157 458, 172 414 C 187 448, 199 468, 195 502 C 193 514, 185 520, 181 528 Z" />
      <path className={s.core} data-vflame d="M 178 520 C 174 492, 168 472, 178 444 C 188 470, 192 486, 190 506 C 189 514, 183 517, 181 522 Z" />
      <circle className={s.bit} data-ember cx="150" cy="404" r="5.5" />
      <circle className={s.bitHot} data-ember cx="205" cy="378" r="4" />
      <circle className={s.bit} data-ember cx="176" cy="352" r="3.5" />
      <circle className={s.bitHot} data-ember cx="138" cy="438" r="3" />
      <circle className={s.bit} data-ember cx="216" cy="422" r="3.5" />
      <circle className={s.bitHot} data-ember cx="192" cy="330" r="2.6" />
    </>
  );
}

export default function Doodle() {
  const root = useRef<SVGSVGElement>(null);

  useIsomorphicLayoutEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const svg = root.current;
    if (!svg) return;
    gsap.registerPlugin(ScrollTrigger, RoughEase);

    // Declared out here so the cleanup can reach it: a gsap.context only reverts
    // tweens, and a ticker callback is neither.
    const shake = { amp: 0 };
    let buzz: (() => void) | undefined;
    // Every tween that repeats forever, so they can be paused while the drawing is
    // off screen. See the observer at the end of this effect.
    const loops: gsap.core.Tween[] = [];

    const ctx = gsap.context(() => {
      // A slow lean, so he reads as holding something rather than posing next to
      // it. Pivoted at his feet — a figure under load bends from the ground.
      loops.push(gsap.to("[data-fig]", {
        rotation: 1.2,
        svgOrigin: "720 745",
        duration: 2.6,
        ease: "sine.inOut",
        yoyo: true,
        repeat: -1,
      }));

      // A flame does not ease. Short, uneven, never at rest, and pinned at its
      // base so it licks upward instead of pulsing. On its own element, so the
      // scroll can grow the aura underneath without the two fighting over one
      // transform.
      loops.push(gsap.to("[data-flame]", {
        scaleY: 1.14,
        scaleX: 0.93,
        svgOrigin: "720 512",
        duration: 0.38,
        ease: "rough({ strength: 1.6, points: 24, clamp: true })",
        yoyo: true,
        repeat: -1,
      }));

      // Every tongue on its own flicker. One shape scaled as a unit reads as a
      // pulsing blob -- fire is several things moving at different speeds, so
      // the duration and the delay both shift per tongue.
      gsap.utils.toArray<SVGElement>(svg.querySelectorAll("[data-vflame]")).forEach((el, i) => {
        loops.push(gsap.to(el, {
          scaleY: 1.26,
          scaleX: 0.88,
          transformOrigin: "50% 100%",
          duration: 0.28 + (i % 4) * 0.08,
          ease: "rough({ strength: 2, points: 20, clamp: true })",
          yoyo: true,
          repeat: -1,
          delay: (i % 5) * 0.06,
        }));
      });

      // Embers rise and go out. Staggered hard, or they pulse together and read
      // as a string of lights rather than as something being thrown.
      gsap.utils.toArray<SVGElement>(svg.querySelectorAll("[data-ember]")).forEach((el, i) => {
        loops.push(gsap.fromTo(
          el,
          { y: 0, opacity: 0.95 },
          {
            y: -46 - (i % 3) * 16,
            opacity: 0,
            duration: 1.5 + (i % 4) * 0.4,
            ease: "power1.out",
            repeat: -1,
            delay: (i % 6) * 0.31,
          },
        ));
      });

      // How hard the whole thing is buzzing. The scroll writes the amplitude and
      // the ticker below reads it, because the tension does not stop being real
      // when the scrolling stops — the buzz has to keep running at whatever level
      // the scroll last left it at. It is on the ticker rather than a repeating
      // tween: a tween with no properties to animate is not reliably re-run, and
      // the first attempt at this simply froze on its first random offset.
      const buzzed = gsap.utils.toArray<SVGElement>(
        svg.querySelectorAll("[data-shake]"),
      );
      let frame = 0;
      buzz = () => {
        // every third frame — smooth noise reads as drift, not as strain
        if (++frame % 3) return;
        const a = shake.amp * 5;
        gsap.set(buzzed, {
          x: gsap.utils.random(-a, a),
          y: gsap.utils.random(-a, a),
        });
      };
      gsap.ticker.add(buzz);

      const tl = gsap.timeline({
        scrollTrigger: {
          // The stage, not the hero: the fall needs the empty paper below it.
          trigger: svg.closest("[data-stage]") ?? svg,
          start: "top top",
          end: "bottom bottom",
          scrub: 0.8,
        },
      });

      // Most of the scroll is the load coming on: the ground opens, the rope goes
      // from a resting curve to a straight line, and because he will not let go
      // the arms are what has to give. scaleY under 1 alongside the stretch is
      // the difference between an arm getting longer and an arm being pulled.
      const SNAP = 0.6;
      // The scene rides up the screen as the load comes on. At rest it sits at
      // the foot of the hero, under the copy; once the copy has gone it has the
      // whole screen and may as well use the middle of it. A share of the
      // viewport rather than a pixel count, so a phone lifts it proportionally.
      tl.to(
        svg,
        { y: () => -window.innerHeight * 0.19, duration: SNAP, ease: "none" },
        0,
      )
        // and it buzzes harder the tighter the rope gets — a line under load is
        // never still, and this is the only cue that says the tension is real
        // before anything visibly gives. Linear and starting the moment the rope
        // leaves its resting curve: on an eased-in ramp the buzz is invisible
        // until it is nearly over, which is exactly the half you cannot feel.
        .to(shake, { amp: 1, duration: SNAP - 0.08, ease: "none" }, 0.08)
        .to(shake, { amp: 0, duration: 0.08, ease: "none" }, SNAP)
        .to("[data-cliff-l]", { x: -260, duration: SNAP, ease: "none" }, 0)
        .to("[data-cliff-r]", { x: 260, duration: SNAP, ease: "none" }, 0)
        .to(
          "[data-rope-l]",
          { attr: { d: ROPE.leftPulled }, duration: SNAP, ease: "none" },
          0,
        )
        .to(
          "[data-rope-r]",
          { attr: { d: ROPE.rightPulled }, duration: SNAP, ease: "none" },
          0,
        )
        .to(
          "[data-arm-l]",
          {
            scaleX: 1.92,
            scaleY: 0.84,
            svgOrigin: SHOULDER.left,
            duration: SNAP,
            ease: "none",
          },
          0,
        )
        .to(
          "[data-arm-r]",
          {
            scaleX: 1.92,
            scaleY: 0.84,
            svgOrigin: SHOULDER.right,
            duration: SNAP,
            ease: "none",
          },
          0,
        )
        // dragged down as the load comes on, before anything gives
        .to(
          "[data-body], [data-aura]",
          { y: 30, duration: SNAP, ease: "none" },
          0,
        )
        // and burning harder the worse it gets
        .to(
          "[data-aura]",
          {
            scale: 1.45,
            opacity: 1,
            svgOrigin: "720 512",
            duration: SNAP,
            ease: "power2.in",
          },
          0,
        )

        // The face carries what the body cannot: cheerful while it is only heavy,
        // gritted once it is costing him, and then simply afraid. Three drawings
        // cross-fading rather than one being tweened, because a mouth does not
        // interpolate into a different mouth.
        .to(
          "[data-face-calm]",
          { opacity: 0, duration: 0.16, ease: "none" },
          0.16,
        )
        .to(
          "[data-face-strain]",
          { opacity: 1, duration: 0.16, ease: "none" },
          0.16,
        )
        .to(
          "[data-face-strain]",
          { opacity: 0, duration: 0.12, ease: "none" },
          SNAP - 0.16,
        )
        .to(
          "[data-face-shock]",
          { opacity: 1, duration: 0.12, ease: "none" },
          SNAP - 0.16,
        )

        // and then it lets go at the shoulder. Arms and rope recoil outward
        // together — they leave fast, the way a parted line does, and the torn
        // ends turn up on the shoulders a beat later, once the arms are clear of
        // them, so the break is something you see rather than infer from a gap.
        .to(
          "[data-arm-l]",
          { x: -330, y: -16, rotation: -24, duration: 0.28, ease: "power3.in" },
          SNAP,
        )
        .to(
          "[data-arm-r]",
          { x: 330, y: -16, rotation: 24, duration: 0.28, ease: "power3.in" },
          SNAP,
        )
        .to(
          "[data-arm-l], [data-arm-r]",
          { opacity: 0, duration: 0.16, ease: "none" },
          SNAP + 0.14,
        )
        .to(
          "[data-tear]",
          { opacity: 1, duration: 0.04, ease: "none" },
          SNAP + 0.12,
        )
        .to(
          "[data-rope]",
          { opacity: 0, duration: 0.16, ease: "none" },
          SNAP + 0.08,
        )

        // The flame goes out with them. It was never his to keep.
        .to(
          "[data-aura]",
          { opacity: 0, scale: 0.7, duration: 0.12, ease: "power2.in" },
          SNAP,
        )

        // He is the last thing to go, and he goes downwards — the whole length of
        // the empty paper under the hero, and only fading once he is well into
        // it. Falling out of frame is the point; blinking out is not.
        .to(
          "[data-body]",
          { y: 620, rotation: 12, duration: 0.4, ease: "power2.in" },
          SNAP,
        )
        .to(
          "[data-body]",
          { opacity: 0, duration: 0.14, ease: "none" },
          SNAP + 0.31,
        )
        .to("[data-cliff-l]", { x: -620, duration: 0.4, ease: "none" }, SNAP)
        .to("[data-cliff-r]", { x: 620, duration: 0.4, ease: "none" }, SNAP)
        // The ground does not just walk away, it goes up. Both craters blow at
        // the same beat the arms give, scaled from the crater mouth so the
        // column grows upward instead of ballooning in every direction.
        .to("[data-lava-l]", { scale: 2.4, svgOrigin: "178 470", duration: 0.4, ease: "power2.out" }, SNAP)
        .to("[data-lava-r]", { scale: 2.4, svgOrigin: "1262 470", duration: 0.4, ease: "power2.out" }, SNAP);
    }, svg);

    // The white band over the dark section. The drawing is a sticky layer that
    // animates every frame (the buzz runs on the ticker, the flames and embers
    // repeat forever), and it went on repainting after it scrolled away. Chrome
    // then composited stale tiles of it -- paper with tan cliffs at the sides --
    // over the clip-pathed dark section below. z-index on that section was not
    // enough. So once the stage is out of view the drawing is hidden outright and
    // nothing in it runs; it comes back, mid-motion, when the stage returns.
    const hold = (svg.closest("[data-stage]") as HTMLElement | null) ?? svg;
    const holder = svg.parentElement;
    let running = true;
    const io = new IntersectionObserver(
      ([entry]) => {
        const visible = entry.isIntersecting;
        if (visible === running) return;
        running = visible;
        if (holder) holder.style.visibility = visible ? "" : "hidden";
        loops.forEach((t) => (visible ? t.resume() : t.pause()));
        if (buzz) (visible ? gsap.ticker.add(buzz) : gsap.ticker.remove(buzz));
      },
      { threshold: 0 }
    );
    io.observe(hold);

    return () => {
      io.disconnect();
      if (holder) holder.style.visibility = "";
      if (buzz) gsap.ticker.remove(buzz);
      ctx.revert();
    };
  }, []);

  return (
    <svg
      ref={root}
      className={s.doodle}
      viewBox="0 340 1440 420"
      preserveAspectRatio="xMidYMax meet"
      fill="none"
      aria-hidden
      focusable="false"
    >
      {/* ── the ground, left and right ─────────────────────────────────── */}
      {/* Not a curve. A curve reads as an eyebrow; land reads as a flat top that
          runs off the screen and then breaks — so the lip overhangs, the face
          steps down in slabs instead of sweeping, and the strata run across it.
          The hatching is what keeps the face from reading as a wall. */}
      {/* Everything in one group, so a narrow screen can scale the whole scene
          about the point he stands on rather than hiding it. At phone width the
          drawing is otherwise a quarter of an inch tall, which is the same as
          not shipping it. */}
      <g className={s.scene}>
        {/* ── the rope ───────────────────────────────────────────────────── */}
        <g className={s.rope} data-rope data-shake>
          <path data-rope-l d={ROPE.leftTaut} />
          <path data-rope-r d={ROPE.rightTaut} />
        </g>

        {/* ── the ground, left and right ─────────────────────────────────── */}
        {/* Land is solid, so it is drawn solid: a filled mass with the edge stroked
          over it, rather than a line pretending to be a cliff. That fill is what
          lets the rope end inside the rock instead of stopping short of it, and
          it is why these come after the rope. A single stroked curve read as an
          eyebrow; what makes it ground is a flat top running off the screen, a
          lip that overhangs, and a face that steps down in slabs. */}
        {/* The outer profile is a volcano now rather than a flat plateau, but the
          gorge lip (302, 601) and the whole inner face below it are untouched:
          ROPE.leftTaut lands at (300, 622), inside that face, and moving the lip
          would tear the rope off the rock. Everything left of 302 is new. */}
        <g className={s.terra} data-cliff-l>
          <path
            className={s.land}
            d="M -4000 706 C -2400 694, -1400 672, -900 656 C -600 644, -420 618, -262 608 C -214 604, -182 558, -150 550 C -100 536, -20 574, 30 556 C 62 544, 110 500, 150 440 L 178 472 L 206 448 C 244 508, 272 556, 302 601 C 328 608, 342 620, 336 638 C 331 656, 306 662, 302 678 C 298 697, 319 707, 317 726 C 315 748, 296 758, 301 782 L 301 2600 L -4000 2600 Z"
          />
          <path d="M -4000 700 C -2400 690, -1400 674, -900 662 C -600 652, -420 632, -262 626 C -214 623, -182 592, -150 586 C -100 576, -20 602, 30 590 C 62 582, 112 556, 150 498" />
          <path className={s.crater} d="M 150 440 L 178 472 L 206 448" />
          <path d="M 206 448 C 244 508, 272 556, 302 601 C 328 608, 342 620, 336 638 C 331 656, 306 662, 302 678 C 298 697, 319 707, 317 726 C 315 748, 296 758, 301 782" />
          <path className={s.strata} d="M 334 648 C 312 652, 292 650, 274 654" />
          <path className={s.strata} d="M 302 690 C 282 694, 264 692, 248 696" />
          <path className={s.strata} d="M 316 734 C 296 738, 278 736, 262 740" />
          <path className={s.hatch} d="M 306 616 L 294 632" />
          <path className={s.hatch} d="M 274 668 L 262 688" />
          <path className={s.hatch} d="M 288 712 L 274 732" />
          <path className={s.hatch} d="M 246 556 L 236 572" />
          <path className={s.hatch} d="M 104 566 L 94 582" />
          <path className={s.strata} d="M 128 486 C 160 512, 196 520, 236 552" />
          <path className={s.strata} d="M 62 560 C 104 566, 152 590, 196 618" />
          <path className={s.strata} d="M -104 596 C -40 586, 26 600, 78 614" />
          <path className={s.hatch} d="M 170 542 L 158 560" />
          <path className={s.hatch} d="M 206 586 L 194 604" />
          <path className={s.hatch} d="M 20 604 L 10 620" />
        </g>

        <g className={s.lava} data-lava-l data-cliff-l>
          <g transform="translate(178,418) scale(1.5) translate(-178,-472)">
            <Eruption />
          </g>
        </g>

        {/* Mirror of the left about x = 720. Same rule: the lip (1138, 601) and the
          inner face below it are untouched, because ROPE.rightTaut ends at
          (1140, 622) and has to stay buried in that rock. */}
        <g className={s.terra} data-cliff-r>
          <path
            className={s.land}
            d="M 5440 706 C 3840 694, 2840 672, 2340 656 C 2040 644, 1860 618, 1702 608 C 1654 604, 1622 558, 1590 550 C 1540 536, 1460 574, 1410 556 C 1378 544, 1330 500, 1290 440 L 1262 472 L 1234 448 C 1198 508, 1170 556, 1138 601 C 1112 608, 1098 620, 1104 638 C 1109 656, 1134 662, 1138 678 C 1142 697, 1121 707, 1123 726 C 1125 748, 1144 758, 1139 782 L 1139 2600 L 5440 2600 Z"
          />
          <path d="M 5440 700 C 3840 690, 2840 674, 2340 662 C 2040 652, 1860 632, 1702 626 C 1654 623, 1622 592, 1590 586 C 1540 576, 1460 602, 1410 590 C 1378 582, 1328 556, 1290 498" />
          <path className={s.crater} d="M 1290 440 L 1262 472 L 1234 448" />
          <path d="M 1234 448 C 1198 508, 1170 556, 1138 601 C 1112 608, 1098 620, 1104 638 C 1109 656, 1134 662, 1138 678 C 1142 697, 1121 707, 1123 726 C 1125 748, 1144 758, 1139 782" />
          <path className={s.strata} d="M 1106 648 C 1128 652, 1148 650, 1166 654" />
          <path className={s.strata} d="M 1138 690 C 1158 694, 1176 692, 1192 696" />
          <path className={s.strata} d="M 1124 734 C 1144 738, 1162 736, 1178 740" />
          <path className={s.hatch} d="M 1134 616 L 1146 632" />
          <path className={s.hatch} d="M 1166 668 L 1178 688" />
          <path className={s.hatch} d="M 1152 712 L 1166 732" />
          <path className={s.hatch} d="M 1194 556 L 1204 572" />
          <path className={s.hatch} d="M 1336 566 L 1346 582" />
          <path className={s.strata} d="M 1312 486 C 1280 512, 1244 520, 1204 552" />
          <path className={s.strata} d="M 1378 560 C 1336 566, 1288 590, 1244 618" />
          <path className={s.strata} d="M 1544 596 C 1480 586, 1414 600, 1362 614" />
          <path className={s.hatch} d="M 1270 542 L 1282 560" />
          <path className={s.hatch} d="M 1234 586 L 1246 604" />
          <path className={s.hatch} d="M 1420 604 L 1430 620" />
        </g>

        <g className={s.lava} data-lava-r data-cliff-r>
          {/* mirrored about x = 720 rather than hand-copied: one set of curves to
              keep in step instead of two that drift apart. */}
          <g transform="translate(1440,0) scale(-1,1)">
            <g transform="translate(178,418) scale(1.5) translate(-178,-472)">
              <Eruption />
            </g>
          </g>
        </g>

        {/* ── the one holding it ─────────────────────────────────────────── */}
        {/* Arms first so the torso, which is paper-filled, covers the sockets they
          come out of. They are their own groups only because they have to leave
          on their own later. */}
        <g data-shake>
          <g className={s.fig} data-fig>
            {/* A torch, not a halo: one teardrop body that is widest below its middle
            and comes to a point, two smaller licks breaking off the sides, and a
            core burning inside it. Radial spikes of even length were the mistake
            — that is a sun. A flame has one shape, and everything else in it is a
            fragment of that shape. */}
            <g className={s.aura} data-aura>
              <g data-flame>
                <path
                  className={s.f1}
                  d="M 686 402 C 672 436, 662 460, 668 480 C 674 496, 690 500, 696 488 C 686 472, 680 440, 686 402 Z"
                />
                <path
                  className={s.f1}
                  d="M 754 402 C 768 436, 778 460, 772 480 C 766 496, 750 500, 744 488 C 754 472, 760 440, 754 402 Z"
                />
                <path
                  className={s.f1}
                  d="M 720 368 C 702 410, 682 432, 680 456 C 678 484, 696 508, 720 516 C 744 508, 762 484, 760 452 C 758 424, 740 396, 720 348 Z"
                />
                <path
                  className={s.f2}
                  d="M 720 386 C 707 424, 696 446, 696 468 C 696 490, 707 506, 720 512 C 733 506, 744 490, 744 468 C 744 446, 733 424, 720 386 Z"
                />
                <path
                  className={s.f3}
                  d="M 720 428 C 713 452, 708 464, 708 478 C 708 492, 713 502, 720 506 C 727 502, 732 492, 732 478 C 732 464, 727 452, 720 428 Z"
                />
              </g>
            </g>

            <g data-arm-l>
              <Tubes parts={ARM_L} />
              <circle className={s.solid} cx="518" cy="622" r="19" />
            </g>
            <g data-arm-r>
              <Tubes parts={ARM_R} />
              <circle className={s.solid} cx="922" cy="622" r="19" />
            </g>

            <g data-body>
              <Tubes parts={LEGS} />
              {/* What is left at the shoulder once the rope has taken the rest.
              Hidden until the tear — see the timeline. */}
              <path
                className={s.tear}
                data-tear
                d="M 648 489 L 660 497 L 646 506 L 660 513 L 650 522"
              />
              <path
                className={s.tear}
                data-tear
                d="M 792 489 L 780 497 L 794 506 L 780 513 L 790 522"
              />

              {/* 143 across the chest, 51 at the waist, lats falling in a concave line */}
              <path
                className={s.solid}
                d="M 705 466 C 684 471, 661 484, 648 504 C 639 522, 642 543, 650 561 C 662 589, 678 617, 688 637 C 691 642, 692 645, 693 648 C 711 651, 729 651, 747 648 C 748 645, 749 642, 752 637 C 762 617, 778 589, 790 561 C 798 543, 801 522, 792 504 C 779 484, 756 471, 735 466 C 725 463, 715 463, 705 466 Z"
              />
              <path className={s.detail} d="M 720 491 L 720 617" />
              <path
                className={s.detail}
                d="M 666 520 C 684 543, 702 550, 716 548"
              />
              <path
                className={s.detail}
                d="M 774 520 C 756 543, 738 550, 724 548"
              />
              <path
                className={s.detail}
                d="M 700 568 C 710 572, 730 572, 740 568"
              />
              <path
                className={s.detail}
                d="M 702 594 C 711 596, 729 596, 738 594"
              />

              {/* No neck. The head is drawn last and set down into the traps, which
              is the whole difference between a bodybuilder and a bobblehead. */}
              <ellipse className={s.solid} cx="720" cy="445" rx="24" ry="27" />

              <g data-face-calm>
                <path className={s.face} d="M 711 437 L 711 440" />
                <path className={s.face} d="M 729 437 L 729 440" />
                <path d="M 711 452 C 716 459, 724 459, 729 452" />
              </g>
              <g className={s.hidden} data-face-strain>
                <path d="M 703 431 L 715 438" />
                <path d="M 737 431 L 725 438" />
                <path className={s.face} d="M 710 444 L 715 444" />
                <path className={s.face} d="M 725 444 L 730 444" />
                <path d="M 709 458 C 715 453, 725 453, 731 458" />
                <path className={s.detail} d="M 716 455 L 716 460" />
                <path className={s.detail} d="M 724 455 L 724 460" />
              </g>
              <g className={s.hidden} data-face-shock>
                <path d="M 701 430 C 707 426, 713 427, 716 431" />
                <path d="M 739 430 C 733 426, 727 427, 724 431" />
                <circle cx="711" cy="440" r="4" />
                <circle cx="729" cy="440" r="4" />
                <ellipse cx="720" cy="458" rx="7" ry="9" />
              </g>
            </g>
          </g>
        </g>
      </g>
    </svg>
  );
}
