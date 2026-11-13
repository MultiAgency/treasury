import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { wallet } from '../apps/server/test/fakes.ts';
import { verifyOwner } from './verify-owner.ts';

test('real NEP-413 signatures bind exact intent and recipient; missing ownership fails closed',async()=>{
 const owner=wallet('owner.near');
 const challenge={message:'Create an isolated synthetic treasury',recipient:'synthetic.test',nonce:randomBytes(32).toString('base64')};
 const signed=owner.sign(challenge);
 const input={...challenge,...signed,account:owner.accountId,expiresAt:Date.now()+60000,lookup:async()=> 'full' as const};
 await verifyOwner(input);
 await assert.rejects(verifyOwner({...input,message:'Changed terms'}),/signature/);
 await assert.rejects(verifyOwner({...input,recipient:'another.test'}),/signature/);
 await assert.rejects(verifyOwner({...input,lookup:async()=> 'limited'}),/Full-access/);
 await assert.rejects(verifyOwner({...input,lookup:async()=> 'unavailable'}),/unavailable/);
 await assert.rejects(verifyOwner({...input,expiresAt:0}),/expired/);
});
