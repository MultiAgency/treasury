import { useEffect, useState } from "react";
import { displayedUsd } from "./prices";
import type { Overview } from "./lib";

/** Prices age even when a refresh fails or a tab remains open. No executor state is changed. */
export function useValuedBook(data: Overview): Overview {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return { ...data,
    book: data.book.map(h => ({ ...h, usd: displayedUsd(h, now) })),
    unmanaged: data.unmanaged.map(h => ({ ...h, usd: h.decimals === null ? null : displayedUsd({ ...h, decimals: h.decimals, public: h.amount, confidential: 0n }, now) })),
  };
}
