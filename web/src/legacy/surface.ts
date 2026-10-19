/** The inherited shared Payables/Portfolio surface. Bundled only when PUBLIC_TREASURY_ONLY=false. */
import type { Legacy } from "./contract";
import { Overview } from "../features/portfolio/overview";
import { PayeesSection } from "../features/payables/payees";
import { PaymentTimeline } from "../features/payables/timeline-payment";
import { PaymentRecovery } from "../features/payables/payment-recovery";
import { SendFunds } from "../features/payables/send-funds";
import { payablesQueriesFor } from "../features/payables/queries";
import { LiveDemo } from "../features/demo/live-demo";
import { clientFor } from "../shared/client";
import { utilsFor } from "../shared/queries";

export const legacy: Legacy = { Overview, PayeesSection, PaymentTimeline, PaymentRecovery, SendFunds, LiveDemo,
  fleetAgreements: name => payablesQueriesFor(utilsFor(clientFor(`/a/${name}`), `/a/${name}`)).agreements };
