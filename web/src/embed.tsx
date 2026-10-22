/**
 * The embeddable Treasury: what a host app loads through Module Federation (`./mount`).
 * It renders the same app as the standalone page and leaves the host's document alone: no theme
 * classes on <html>, no routing outside the container. See docs/embedding.md for what the host must provide.
 */
import { createRoot } from "react-dom/client";
import { TreasuryRoot } from "./treasury-root";
import "./styles.css";
import "./treasury-theme.css";

export type TreasuryEmbed = { unmount: () => void };

export function mount(container: HTMLElement): TreasuryEmbed {
  const root = createRoot(container);
  root.render(<TreasuryRoot />);
  return { unmount: () => root.unmount() };
}
