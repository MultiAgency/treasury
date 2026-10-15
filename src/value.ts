/** Raw units of a token with `decimals` at `price`, in USD. */
export const usdValue = (raw: bigint | string | number, decimals: number, price: number) => (Number(raw) / 10 ** decimals) * price;

/** What an exchange loses, in basis points of its input's value: fees, price impact and slippage. */
export const costBps = (usdIn: number, usdOut: number) => (1 - usdOut / usdIn) * 10_000;
