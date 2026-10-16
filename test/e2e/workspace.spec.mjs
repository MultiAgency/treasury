import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { environment } from './environment.mjs';
import { browserContext } from './wallet.mjs';
import { OWNER, PAYEE } from './provider.mjs';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { request as httpsRequest } from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';

async function rpc(page, agent, method, input) {
  return page.evaluate(async ({ agent, method, input }) => {
    const response = await fetch(`/a/${agent}/rpc/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ json: input }) });
    return { status: response.status, body: await response.json() };
  }, { agent, method, input });
}
async function signedPage(browser, stack, account, path) {
  const wallet = await browserContext(browser, stack, account);
  await wallet.context.tracing.start({ screenshots: true, snapshots: true });
  const page = await wallet.context.newPage();
  await page.goto(`${stack.dashboard}${path}`);
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).first().click();
  await expect.poll(async () => page.evaluate(async () => (await (await fetch('/gw/me')).json()).viewer?.account)).toBe(account);
  return { ...wallet, page };
}
async function scenario(browser, info, run, options = {}) {
  const stack = await environment(info.outputPath('environment'), { workspace: true, ...options });
  stack.browserVersion = browser.version();
  const wallets = [];
  try { await run(stack, async (account, path) => { const wallet = await signedPage(browser, stack, account, path); wallets.push(wallet); return wallet; }); }
  finally {
    for (const [i, wallet] of wallets.entries()) {
      await wallet.page.screenshot({ path: info.outputPath(`${i}.png`), fullPage: true }).catch(() => {});
      writeFileSync(info.outputPath(`${i}.txt`), await wallet.page.locator('body').innerText().catch(() => 'unavailable'));
      await wallet.context.tracing.stop({ path: info.outputPath(`trace-${i}.zip`) });
      await wallet.context.close();
    }
    await stack.close();
    expect(stack.simulated.errors).toEqual([]); expect(stack.portfolio.errors).toEqual([]);
    for (const wallet of wallets) expect(wallet.unexpected).toEqual([]);
  }
}

test('outside agent prepares its own swaps and executes the exact plan through Treasury', async ({ browser }, info) => {
  await scenario(browser, info, async (stack, login) => {
    const { page } = await login(PAYEE, '/a/portfolio/');
    const issued = await page.evaluate(async () => {
      const response = await fetch('/gw/machine-credentials/portfolio', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'offline external strategy', scopes: ['read', 'prepare', 'execute-plan'], ttlSeconds: 60 }) });
      if (!response.ok) throw new Error(`Issuance failed: ${response.status}`);
      return response.json();
    });
    // A separate Node client, with no browser cookies. Only this fixture accepts its local self-signed TLS certificate.
    const localFetch = (url, options) => new Promise((resolve, reject) => {
      const req = httpsRequest(url, { method: options.method, headers: Object.fromEntries(new Headers(options.headers)), rejectUnauthorized: false }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
      });
      req.on('error', reject); req.end(options.body);
    });
    const client = createORPCClient(new RPCLink({ origin: stack.dashboard, url: '/machine/v1/a/portfolio/rpc',
      headers: { authorization: `Bearer ${issued.token}` }, fetch: localFetch }));
    expect((await client.instance()).agentId).toBe(stack.portfolio.id);
    const chosen = { from: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', to: 'nep141:wrap.near', amount: '1000000' };
    const inputFile = info.outputPath('external-swaps.json');
    writeFileSync(inputFile, JSON.stringify({ swaps: [chosen] }));
    const cli = async (...args) => (await promisify(execFile)(process.execPath,
      [resolve('skills/treasury/scripts/treasury.mjs'), ...args], { env: { ...process.env,
        TREASURY_URL: stack.dashboard, TREASURY_NAME: 'portfolio', TREASURY_MACHINE_TOKEN: issued.token,
        NODE_EXTRA_CA_CERTS: join(stack.directory, 'localhost.crt') }, timeout: 30_000 })).stdout;
    const plan = JSON.parse(await cli('prepare', inputFile));
    expect(plan.source).toBe('external'); expect(plan.actions[0]).toMatchObject(chosen);
    expect(stack.portfolio.swaps).toHaveLength(0);
    const events = (await cli('execute', plan.id)).trim().split('\n').map(line => JSON.parse(line));
    expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ type: 'action', status: 'SUCCESS' });
    expect(stack.portfolio.swaps).toHaveLength(1);
    expect(stack.portfolio.swaps[0].body).toMatchObject({ origin_asset: chosen.from, destination_asset: chosen.to, amount: chosen.amount, min_amount_out: plan.actions[0].minAmountOut });
    const again = []; for await (const event of await client.executePlan({ planId: plan.id })) again.push(event);
    expect(again[0].type).toBe('rejected'); expect(stack.portfolio.swaps).toHaveLength(1);
    const activity = await client.activity();
    expect(activity.some(op => op.planId === plan.id && op.status === 'SUCCESS')).toBe(true);
    await page.evaluate(async id => { const response = await fetch(`/gw/machine-credentials/portfolio/${id}`, { method: 'DELETE' }); if (!response.ok) throw new Error('Revoke failed'); }, issued.credential.id);
    await expect(client.instance()).rejects.toThrow();
    expect(stack.portfolio.swaps).toHaveLength(1);
  });
});

test('cross-agent navigation keeps identity and gateway permissions isolated', async ({ browser }, info) => {
  await scenario(browser, info, async (stack, login) => {
    const { page } = await login(OWNER, '/a/payout/');
    await expect(page.getByRole('heading', { name: 'Payments', exact: true })).toBeVisible();
    const payout = await rpc(page, 'payout', 'instance');
    expect(payout.body.json.agentId).toBe(stack.simulated.id);
    await page.getByRole('navigation', { name: 'Area', exact: true }).getByRole('link', { name: 'Agreements', exact: true }).click();
    await expect(page.getByRole('article', { name: `Recipient ${PAYEE}`, exact: true })).toBeVisible();
    const offer = page.getByText('Offer terms (a purchase order, a bounty or grant award)', { exact: true });
    await expect(offer).toBeVisible();
    expect(await offer.evaluate(element => element.parentElement.open)).toBe(false);
    await page.getByRole('navigation', { name: 'Area', exact: true }).getByRole('link', { name: 'Payments', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Payments', exact: true })).toBeVisible();
    // Cross-agent links must cause a document navigation, resetting client/cache ownership.
    await page.evaluate(() => { window.__candidateDocument = 'payout'; });
    const link = page.locator('a[href="/a/portfolio/"]').first();
    await link.click();
    await expect.poll(() => page.evaluate(() => window.__candidateDocument)).toBeUndefined();
    expect((await rpc(page, 'portfolio', 'instance')).body.json.agentId).toBe(stack.portfolio.id);
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Payments', exact: true })).toBeVisible();
    expect((await rpc(page, 'payout', 'instance')).body.json.agentId).toBe(stack.simulated.id);
    expect(stack.simulated.intents).toHaveLength(0);
    expect(stack.simulated.transfers).toHaveLength(0);
    expect(stack.portfolio.intents).toHaveLength(0);
    expect(stack.portfolioState().strategy).toBeNull();
  }, { portfolioOwner: OWNER });
});

test('each wallet sees only its own agents despite legacy operator configuration', async ({ browser }, info) => {
  await scenario(browser, info, async (stack, login) => {
    const owner = await login(OWNER, '/a/payout/');
    const ownerView = await owner.page.evaluate(async () => (await fetch('/gw/me')).json());
    expect(Object.keys(ownerView.viewer.access)).toEqual(['payout']);
    expect(ownerView.viewer.access.payout).toEqual({ canSign: true, canPropose: false, canVote: false, canExecute: true, canManage: true });
    expect((await rpc(owner.page, 'portfolio', 'instance')).status).toBe(403);
    expect((await rpc(owner.page, 'portfolio', 'autopilot/stop')).status).toBe(403);
    const restricted = await login(PAYEE, '/a/portfolio/automations');
    const me = await restricted.page.evaluate(async () => (await fetch('/gw/me')).json());
    expect(Object.keys(me.viewer.access)).toEqual(['portfolio']);
    expect(me.agents.map(a => a.name)).toEqual(['portfolio']);
    expect((await rpc(restricted.page, 'payout', 'instance')).status).toBe(403);
    expect((await rpc(restricted.page, 'payout', 'autopilot/stop')).status).toBe(403);
    await restricted.page.goto(`${stack.dashboard}/a/payout/`);
    await expect(restricted.page.getByRole('heading', { name: 'Payments', exact: true })).toHaveCount(0);
    expect(stack.simulated.intents).toHaveLength(0);
    expect(stack.simulated.transfers).toHaveLength(0);
    expect(stack.portfolio.intents).toHaveLength(0);
    expect(stack.portfolioState().strategy).toBeNull();
  });
});

test('strategy saves off, authorizes, rejects stale review, enables explicitly and stops during provider failure', async ({ browser }, info) => {
  await scenario(browser, info, async (stack, login) => {
    const { page, signatures } = await login(PAYEE, '/a/portfolio/automations');
    await expect(page.getByRole('heading', { name: 'Strategy', exact: true })).toBeVisible();
    const original = (await rpc(page, 'portfolio', 'strategy/get')).body.json;
    await page.getByRole('button', { name: 'Edit strategy', exact: true }).click();
    await page.getByLabel('USDC (%)', { exact: true }).fill('60');
    await page.getByLabel('wNEAR (%)', { exact: true }).fill('20');
    await page.getByLabel('ETH (%)', { exact: true }).fill('20');
    await page.getByLabel('Run every (minutes)', { exact: true }).fill('120');
    await page.getByRole('button', { name: 'Save with autopilot off', exact: true }).click();
    await expect.poll(() => stack.portfolioState().strategy?.autopilot.everyMin).toBe(120);
    expect(stack.portfolioState().settings).toMatch(/AUTOPILOT=\n/);
    expect(stack.portfolio.intents).toHaveLength(0);
    const saved = (await rpc(page, 'portfolio', 'strategy/get')).body.json;
    expect(saved.digest).not.toBe(original.digest);
    // An old tab cannot overwrite, authorize, or enable the newly saved strategy.
    for (const [method, input] of [
      ['strategy/save', { strategy: original.strategy, expectedDigest: original.digest }],
      ['owner/prepare', { action: { type: 'grant_issue', label: 'treasury', expectedStrategyDigest: original.digest } }],
      ['autopilot/enable', { expectedDigest: original.digest }],
    ]) expect((await rpc(page, 'portfolio', method, input)).status).toBeGreaterThanOrEqual(400);
    expect(stack.portfolio.intents).toHaveLength(0);
    expect(stack.portfolioState().strategy).toEqual(saved.strategy);
    await expect(page.getByRole('heading', { name: 'Authorize this saved strategy', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Authorize in wallet', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Turn on', exact: true })).toBeVisible();
    expect(stack.portfolio.intents).toHaveLength(1);
    expect(stack.portfolio.grants.at(-1).label).toBe(`treasury:${saved.digest.slice(7, 39)}`);
    expect(signatures.filter(s => s.recipient === 'local-provider')).toHaveLength(1);
    expect(stack.portfolioState().settings).toMatch(/AUTOPILOT=\n/);
    await page.getByRole('button', { name: 'Turn on', exact: true }).click();
    expect(stack.portfolioState().settings).toMatch(/AUTOPILOT=\n/);
    await page.getByRole('dialog').getByRole('button', { name: 'Turn on', exact: true }).click();
    await expect.poll(() => stack.portfolioState().settings).toMatch(/AUTOPILOT=on\n/);
    stack.portfolio.setUnavailable(true);
    // Establish a real provider failure before using the provider-independent stop control.
    expect((await rpc(page, 'portfolio', 'overview')).status).toBeGreaterThanOrEqual(400);
    await page.getByRole('button', { name: 'Turn off', exact: true }).click();
    await expect.poll(() => stack.portfolioState().settings).toMatch(/AUTOPILOT=\n/);
    expect((await rpc(page, 'portfolio', 'autopilot/get')).body.json.on).toBe(false);
    await page.reload();
    expect((await rpc(page, 'portfolio', 'autopilot/get')).body.json.on).toBe(false);
    expect(stack.portfolio.transfers).toHaveLength(0);
    expect(stack.portfolio.requests.filter(r => r.method === 'POST' && r.path !== '/chain').map(r => r.path)).toEqual(['/v1/generate-intent', '/v1/submit-intent']);
  });
});
