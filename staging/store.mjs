// @ts-check
import { enforcePolicy } from './policy.mjs';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';

/** @template T @param {import('node:sqlite').SQLOutputValue | undefined} value @returns {T} */
function decode(value) {
  if (typeof value !== 'string') throw Error('Invalid stored JSON');
  // Store writes bind each collection to its record shape; JSON parsing is the persistence boundary.
  return /** @type {T} */ (JSON.parse(value));
}
/** @param {import('node:sqlite').SQLOutputValue | undefined} value */
function text(value) {
  if (typeof value !== 'string') throw Error('Invalid stored operation');
  return value;
}

/** Durable synthetic state only. Never accepts provider URLs or signing keys. */
export class SyntheticStore {
  /** @param {string} path */
  constructor(path) {
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,terms TEXT NOT NULL,status TEXT NOT NULL,result TEXT);`);
  }
  /** @template {keyof import('./types.ts').Records} K @param {K} kind @param {string} id @returns {import('./types.ts').Records[K] | null} */
  read(kind, id) {
    const row = this.db.prepare('SELECT value FROM records WHERE kind=? AND id=?').get(kind,id);
    return row ? decode(row.value) : null;
  }
  /** @template {keyof import('./types.ts').Records} K @param {K} kind @param {string} id @param {import('./types.ts').Records[K]} value */
  create(kind,id,value) {
    this.db.prepare('INSERT INTO records VALUES(?,?,?)').run(kind,id,JSON.stringify(value));
  }
  /** @template {keyof import('./types.ts').Records} K @param {K} kind @returns {import('./types.ts').Records[K][]} */
  list(kind) { return this.db.prepare('SELECT value FROM records WHERE kind=? ORDER BY id').all(kind).map(row=>decode(row.value)); }
  /** @template {keyof import('./types.ts').Records} K @param {K} kind @param {string} id @param {import('./types.ts').Records[K]} value */
  replace(kind,id,value) {
    const changed=this.db.prepare('UPDATE records SET value=? WHERE kind=? AND id=?').run(JSON.stringify(value),kind,id);
    if(changed.changes!==1) throw Error('Unknown record');
  }
  /** @template T @param {() => T & (T extends PromiseLike<unknown> ? never : unknown)} work @returns {T} */
  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result=work(); this.db.exec('COMMIT'); return result; }
    catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** @param {string} agent @returns {import('./types.ts').SwapResult[]} */
  history(agent) { return this.db.prepare("SELECT result FROM operations WHERE status='SUCCESS'").all().map(row=>/** @type {import('./types.ts').SwapResult} */ (decode(row.result))).filter(op=>op.agent===agent); }
  /** @param {string} id @returns {import('./types.ts').SwapOperation | null} */
  operation(id) {
    const row = this.db.prepare('SELECT * FROM operations WHERE id=?').get(id);
    return row ? {id: text(row.id), terms: text(row.terms), status: text(row.status), result: row.result === null ? null : text(row.result)} : null;
  }
  /** Claim only the exact reviewed intent. Verification must finish before entering this synchronous transaction. */
  /** @param {string} id @param {import('./types.ts').Intent} expected @param {{agent_id: string}} result @param {() => undefined} apply */
  completeIntent(id, expected, result, apply = () => {}) {
    return this.transaction(() => {
      const intent=this.read('intent',id);
      if(!intent || JSON.stringify(intent)!==JSON.stringify(expected)) throw Error('Intent changed or already consumed');
      if(intent.status!=='PENDING_SIGNATURE' || !Number.isFinite(intent.expiresAt) || intent.expiresAt<=Date.now()) throw Error('Intent is not open');
      apply();
      const completed={...intent,status:/** @type {const} */ ('SUCCESS'),result};
      this.db.prepare('UPDATE records SET value=? WHERE kind=? AND id=?').run(JSON.stringify(completed),'intent',id);
      return completed;
    });
  }
  /** Debit, credit and operation receipt commit together; replay cannot move balances twice. */
  /** @param {string} id @param {import('./types.ts').SwapTerms} terms @param {number} now @returns {import('./types.ts').SwapResult} */
  swap(id,{agent,from,to,amount,output,minAmountOut},now=Date.now()) {
    if(!/^[1-9][0-9]*$/.test(amount)||!/^[1-9][0-9]*$/.test(output)||from===to) throw Error('Invalid swap');
    const terms=JSON.stringify({agent,from,to,amount,output,minAmountOut});
    return this.transaction(()=>{
      const old=this.operation(id);
      if(old) { if(old.terms!==terms) throw Error('Request conflict'); return /** @type {import('./types.ts').SwapResult} */ (decode(old.result)); }
      const state=this.read('agent',agent);
      if(!state) throw Error('Unknown agent');
      if(state.frozen) throw Error('Frozen');
      enforcePolicy(state,{from,to,amount},this.history(agent),now);
      const balance=state.balances[from]??'0';
      if(BigInt(balance)<BigInt(amount)) throw Error('Insufficient balance');
      state.balances[from]=(BigInt(balance)-BigInt(amount)).toString();
      state.balances[to]=(BigInt(state.balances[to]??'0')+BigInt(output)).toString();
      const result={id,status:/** @type {const} */ ('SUCCESS'),agent,from,to,amount,output,at:new Date(now).toISOString()};
      this.db.prepare('UPDATE records SET value=? WHERE kind=? AND id=?').run(JSON.stringify(state),'agent',agent);
      this.db.prepare('INSERT INTO operations VALUES(?,?,?,?)').run(id,terms,'SUCCESS',JSON.stringify(result));
      return result;
    });
  }
  close(){this.db.close();}
}
