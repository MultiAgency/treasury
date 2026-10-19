import { useLocation } from "@tanstack/react-router";
import { useEffect } from "react";

/**
 * A deep link's `#id` is revealed once its element exists. Most targets render only after the agent's
 * reads arrive, so a browser's own hash scroll on load finds nothing; this waits, briefly, for the target.
 */
export function useHashTarget() {
  const hash = useLocation({ select: location => location.hash });
  useEffect(() => {
    if (!hash) return;
    const reveal = () => {
      const target = document.getElementById(hash);
      target?.scrollIntoView({ block: "start" });
      return Boolean(target);
    };
    if (reveal()) return;
    const observer = new MutationObserver(() => { if (reveal()) stop(); });
    const timer = setTimeout(() => stop(), 10_000);
    const stop = () => { observer.disconnect(); clearTimeout(timer); };
    observer.observe(document.body, { childList: true, subtree: true });
    return stop;
  }, [hash]);
}
