import { enforcePolicy } from './policy.mjs';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';

/** Durable synthetic state only. Never accepts provider URLs or signing keys. */
export class SyntheticStore {
  constructor(path) {
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,terms TEXT NOT NULL,status TEXT NOT NULL,result TEXT);`);
  }
  read(kind, id) {
    const row = this.db.prepare('SELECT value FROM records WHERE kind=? AND id=?').get(kind,id);
    return row ? JSON.parse(row.value) : null;
  }
  create(kind,id,value) {
    this.db.prepare('INSERT INTO records VALUES(?,?,?)').run(kind,id,JSON.stringify(value));
  }
  list(kind) { return this.db.prepare('SELECT value FROM records WHERE kind=? ORDER BY id').all(kind).map(row=>JSON.parse(row.value)); }
  replace(kind,id,value) {
    const changed=this.db.prepare('UPDATE records SET value=? WHERE kind=? AND id=?').run(JSON.stringify(value),kind,id);
    if(changed.changes!==1) throw Error('Unknown record');
  }
  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result=work(); this.db.exec('COMMIT'); return result; }
    catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  history(agent) { return this.db.prepare("SELECT result FROM operations WHERE status='SUCCESS'").all().map(row=>JSON.parse(row.result)).filter(op=>op.agent===agent); }
  operation(id) { return this.db.prepare('SELECT * FROM operations WHERE id=?').get(id) ?? null; }
  /** Claim only the exact reviewed intent. Verification must finish before entering this synchronous transaction. */
  completeIntent(id, expected, result, apply = () => {}) {
    return this.transaction(() => {
      const intent=this.read('intent',id);
      if(!intent || JSON.stringify(intent)!==JSON.stringify(expected)) throw Error('Intent changed or already consumed');
      if(intent.status!=='PENDING_SIGNATURE' || !Number.isFinite(intent.expiresAt) || intent.expiresAt<=Date.now()) throw Error('Intent is not open');
      apply();
      const completed={...intent,status:'SUCCESS',result};
      this.db.prepare('UPDATE records SET value=? WHERE kind=? AND id=?').run(JSON.stringify(completed),'intent',id);
      return completed;
    });
  }
  /** Debit, credit and operation receipt commit together; replay cannot move balances twice. */
  swap(id,{agent,from,to,amount,output,minAmountOut},now=Date.now()) {
    if(!/^[1-9][0-9]*$/.test(amount)||!/^[1-9][0-9]*$/.test(output)||from===to) throw Error('Invalid swap');
    const terms=JSON.stringify({agent,from,to,amount,output,minAmountOut});
    return this.transaction(()=>{
      const old=this.operation(id);
      if(old) { if(old.terms!==terms) throw Error('Request conflict'); return JSON.parse(old.result); }
      const state=this.read('agent',agent);
      if(!state) throw Error('Unknown agent');
      if(state.frozen) throw Error('Frozen');
      enforcePolicy(state,{from,to,amount},this.history(agent),now);
      if(BigInt(state.balances[from]??'0')<BigInt(amount)) throw Error('Insufficient balance');
      state.balances[from]=(BigInt(state.balances[from])-BigInt(amount)).toString();
      state.balances[to]=(BigInt(state.balances[to]??'0')+BigInt(output)).toString();
      const result={id,status:'SUCCESS',agent,from,to,amount,output,at:new Date(now).toISOString()};
      this.db.prepare('UPDATE records SET value=? WHERE kind=? AND id=?').run(JSON.stringify(state),'agent',agent);
      this.db.prepare('INSERT INTO operations VALUES(?,?,?,?)').run(id,terms,'SUCCESS',JSON.stringify(result));
      return result;
    });
  }
  close(){this.db.close();}
}
