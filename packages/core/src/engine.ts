// The band engine (A4): zone → size → anti-whipsaw gate, in that order, as one pure function.

import { BAND_DEFAULTS, proposeZone, type Bands, type Proposal } from "./bands.ts";
import type { OracleReading } from "./oracle.ts";
import { SIZING_DEFAULTS, sizeProposal, type Portfolio, type SizingParams, type SizingState, type WeightBounds } from "./sizing.ts";
import { gate, WHIPSAW_DEFAULTS, type Regime, type WhipsawLimits, type WhipsawState } from "./whipsaw.ts";

export type EngineInput = {
  portfolio: Portfolio;
  bounds: WeightBounds;
  sizing: SizingState;
  whipsaw: WhipsawState;
  regime: Regime;
};

export type EngineConfig = { bands: Bands; sizing: SizingParams; whipsaw: WhipsawLimits };
export const ENGINE_DEFAULTS: EngineConfig = { bands: BAND_DEFAULTS, sizing: SIZING_DEFAULTS, whipsaw: WHIPSAW_DEFAULTS };

/** One proposal for one reading. Holds whenever the oracle is frozen, the state is unusable or the gate says wait. */
export function evaluateBands(reading: OracleReading, input: EngineInput, config: EngineConfig = ENGINE_DEFAULTS): Proposal {
  const zone = proposeZone(reading, config.bands);
  const sized = sizeProposal(zone, input.portfolio, input.bounds, input.sizing, config.sizing);
  return gate(sized, input.whipsaw, input.regime, reading.at, config.whipsaw);
}
