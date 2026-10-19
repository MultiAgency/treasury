/** Complete plan-stream events, as `rebalance` and `executePlan` send them; scenarios name only what they test. */
const holding = ({ asset, symbol, decimals, price = 1, public: open = 0n, confidential = 0n, usd = 0 }) =>
  ({ asset, symbol, decimals, price, public: BigInt(open), confidential: BigInt(confidential), usd });
const strategy = { targetBps: { usdc: 10000 }, minLegUsd: 1, maxCostBps: 100, autopilot: { everyMin: 60, maxUsd: 10 } };

/** The preview's `plan` event: its legs, plus the book and strategy the server planned from. */
function planEvent({ legs, budget = null }) {
  const complete = legs.map(leg => ({ ...leg, from: holding(leg.from), to: holding(leg.to), amount: BigInt(leg.amount) }));
  const book = [...new Map(complete.flatMap(leg => [leg.from, leg.to]).map(h => [h.asset, h])).values()];
  return { type: 'plan', total: book.reduce((sum, h) => sum + h.usd, 0), book, legs: complete, budget: budget === null ? null : String(budget), strategy };
}

/** The saved plan behind a preview: one swap action per quoted leg. */
function savedEvent({ id, expiresAt, legs, quotes, steps }) {
  return { type: 'saved', steps, plan: { id, source: 'rebalance', createdAt: '2026-10-15T12:00:00Z', expiresAt, instruction: '',
    actions: legs.map((leg, i) => ({ type: 'swap', from: leg.from.asset, to: leg.to.asset, amount: String(leg.amount),
      amountOut: quotes[i].amountOut, minAmountOut: quotes[i].minAmountOut, costBps: quotes[i].costBps })),
    agentId: 'fixture', policyRevision: 1, policyDigest: 'fixture', strategyDigest: 'fixture', balances: {} } };
}

/** An `executePlan` action result for one saved swap. */
const actionEvent = ({ index, status, correlationId, failureCode = null, action = { type: 'swap', from: 'usdc', to: 'near', amount: '1000000',
  amountOut: '1000000000000000000000000', minAmountOut: '990000000000000000000000', costBps: 5 } }) =>
  ({ type: 'action', index, action, status, correlationId, failureCode });

module.exports = { planEvent, savedEvent, actionEvent };
