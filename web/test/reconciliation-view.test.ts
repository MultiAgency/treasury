import assert from "node:assert/strict";
import { test } from "node:test";
import { confidentialStanding, incomingCreditBasis } from "../src/reconciliation-view.ts";
test("private book copy distinguishes missing incoming history, shortfall and matched records", () => {
 assert.equal(confidentialStanding("10000000"),"Incoming history incomplete");
 assert.equal(confidentialStanding("-10000000"),"Balance below recorded funds");
 assert.equal(confidentialStanding("0"),"Recorded balance matches");
 assert.equal(confidentialStanding("bad"),"History unavailable");
});

test("applied manual credits stay labelled as operator attestations, including mixed evidence", () => {
 assert.equal(incomingCreditBasis({}),null);
 assert.equal(incomingCreditBasis({credits:[]}),null);
 assert.equal(incomingCreditBasis({credits:[{evidence:"operator-receipt"},{evidence:"provider-status"}]}),"Includes operator-attested funding receipts");
 assert.equal(incomingCreditBasis({credits:[{evidence:"provider-status"}]}),"Includes provider-reported funding credits");
 assert.equal(incomingCreditBasis({credits:[{evidence:"unknown"}]}),"Incoming credit evidence unavailable");
});
