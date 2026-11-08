/** Whether the visitor asked for less motion: then nothing scrolls smoothly, autoplays or is scrubbed by the scroll. */
export const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Scrolls the landing to one of its sections by id, and moves the focus there too, so a keyboard or screen reader user
 * continues from the section they asked for.
 */
export function scrollToSection(id: string) {
  const section = document.getElementById(id);
  if (!section) return;
  section.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
  if (!section.hasAttribute("tabindex")) section.setAttribute("tabindex", "-1");
  section.focus({ preventScroll: true });
}
