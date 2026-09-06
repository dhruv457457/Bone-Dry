import { useEffect, useLayoutEffect } from "react";

/** gsap.from writes its start state when the tween is created. In useEffect that
 *  happens after paint, so the content flashes in and then hides itself before
 *  animating. Before paint, there is nothing to see. Falls back to useEffect on
 *  the server, where there is no layout to run against. */
export const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;
