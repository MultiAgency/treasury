/**
 * Same-origin signal between this host's tabs: a sign-in or sign-out in one tab tells the others to
 * reread the gateway session at once, instead of trusting an identity that may have changed. The
 * channel and message are Payables' too, so the apps agree if they share an origin; any message on
 * the channel only causes a reread.
 */
const CHANNEL = "multiagency-session";

export function announceSessionChange() {
  try { const channel = new BroadcastChannel(CHANNEL); channel.postMessage("changed"); channel.close(); } catch { /* No channel: other tabs reread on focus. */ }
}

export function onSessionChange(listener: () => void) {
  try {
    const channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = () => listener();
    return () => channel.close();
  } catch { return () => {}; }
}
