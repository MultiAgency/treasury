// The band engine (A4): zone → size → anti-whipsaw gate, in that order, as one pure function.

import { BAND_DEFAULTS, intentForZone, type Bands, type Intent } from "./bands.ts";
import type { OracleReading } from "./oracle.ts";
import { SIZING_DEFAULTS, sizeIntent, type Portfolio, type SizingParams, type SizingState, type WeightBounds } from "./sizing.ts";
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

/** One intent for one reading. Holds whenever the oracle is frozen, the state is unusable or the gate says wait. */
export function evaluateBands(reading: OracleReading, input: EngineInput, config: EngineConfig = ENGINE_DEFAULTS): Intent {
  const zone = intentForZone(reading, config.bands);
  const sized = sizeIntent(zone, input.portfolio, input.bounds, input.sizing, config.sizing);
  return gate(sized, input.whipsaw, input.regime, reading.at, config.whipsaw);
}
