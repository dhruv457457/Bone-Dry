"use client";

import { useEffect } from "react";
import Lenis from "lenis";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

/**
 * One scroll loop for the whole page.
 *
 * Lenis smooths the wheel; ScrollTrigger scrubs timelines against it. They have
 * to share a single requestAnimationFrame — two independent loops drift apart by
 * a frame and everything scrubbed against scroll position jitters. GSAP's ticker
 * drives Lenis, and ScrollTrigger is told to ask Lenis for the scroll position
 * rather than reading window.scrollY, which Lenis no longer controls.
 *
 * Anyone who has asked their system not to animate gets a plain scrollbar and no
 * timelines at all. That is not a lesser experience; the page is legible without
 * a single transform, because the motion decorates the argument rather than
 * carrying it.
 */
export default function Motion({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;

    gsap.registerPlugin(ScrollTrigger);

    const lenis = new Lenis({
      duration: 1.05,
      // Slightly overshooting ease-out: fast to respond, unhurried to settle.
      easing: (t: number) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      smoothWheel: true,
      touchMultiplier: 1.6,
    });

    lenis.on("scroll", ScrollTrigger.update);

    const tick = (time: number) => lenis.raf(time * 1000); // gsap seconds -> lenis ms
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);

    ScrollTrigger.scrollerProxy(document.body, {
      scrollTop(value) {
        if (typeof value === "number") lenis.scrollTo(value, { immediate: true });
        return lenis.scroll;
      },
    });

    // Images and fonts land after mount and change every measurement under them.
    const refresh = () => ScrollTrigger.refresh();
    document.fonts?.ready.then(refresh).catch(() => {});
    window.addEventListener("load", refresh);

    return () => {
      window.removeEventListener("load", refresh);
      gsap.ticker.remove(tick);
      ScrollTrigger.getAll().forEach((t) => t.kill());
      lenis.destroy();
    };
  }, []);

  return <>{children}</>;
}
