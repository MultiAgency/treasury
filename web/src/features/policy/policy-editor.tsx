import type { Policy as AgentPolicy } from "@near-intents-agent-api/sdk";
import { useEffect, useState } from "react";
import type { Overview } from "../../shared/lib";
import { ownerSigner, type Setup, useOwnerAction, useSigner } from "../owner/owner";
import { allowsAsset, BUDGET, changesOf, type Draft, differences, draftOf, WINDOWS } from "./policy-draft";
import { focusInvalid } from "../../shared/form";
import { useDirtyDraft, confirmDiscard } from "../../shared/dirty-draft";
import { Button, Card, ErrorBox, input, Spinner } from "../../shared/ui";
import { reviewedPolicyOf, sameReviewedPolicy } from "./policy-review";

function Toggle({ checked, onChange, children }: { checked: boolean; onChange: (checked: boolean) => void; children: string }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> {children}
    </label>
  );
}

/**
 * Edits the envelope and proposes it as one policy update, signed like every owner action: by
 * the owner's wallet, or by the DAO in one proposal. Destinations are edited under Payees.
 */
export function Editor({ policy, data, setup, onDone }: { policy: AgentPolicy; data: Overview; setup: Setup; onDone: () => void }) {
  const [baseline, setBaseline] = useState(() => ({ draft: draftOf(policy, data.book), policy: reviewedPolicyOf(data) }));
  const [draft, setDraft] = useState(baseline.draft);
  const [reviewing, setReviewing] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const action = useOwnerAction(setup);
  const { canSign } = useSigner(setup);
  useEffect(() => { if (!canSign) setReviewing(false); }, [canSign]);
  const result = changesOf(draft, data.book, policy);
  const lines = differences(baseline.draft, draft, data.book);
  const currentPolicy = reviewedPolicyOf(data);
  const stale = !sameReviewedPolicy(baseline.policy, currentPolicy);
  const set = (patch: Partial<Draft>) => {
    setReviewing(false);
    setDraft({ ...draft, ...patch });
  };
  const viaDao = ownerSigner(setup) === "dao";
  const dirty = lines.length > 0;
  useDirtyDraft((dirty || stale) && !action.busy);
  const invalid = submitted && "invalid" in result ? result.invalid : undefined;
  const fieldError = (name: string) => invalid === name;
  const cancel = () => { if (!dirty || confirmDiscard()) onDone(); };

  return (
    <Card>
      <form noValidate className="flex min-w-0 flex-col gap-5" onSubmit={(e) => {
        e.preventDefault();
        setSubmitted(true);
        if ("invalid" in result) { focusInvalid(e.currentTarget); return; }
        if (dirty && !stale && !action.busy && canSign) setReviewing(true);
      }}>
      <div className="flex flex-col gap-3">
        <h3 className="text-lg font-medium">What the agent may do</h3>
        <Toggle checked={draft.swap} onChange={(swap) => set({ swap })}>
          Swap between its assets
        </Toggle>
        <Toggle checked={draft.ownerApproval} onChange={(ownerApproval) => set({ ownerApproval })}>
          Every payment waits for the owner's approval
        </Toggle>
        <Toggle checked={draft.assets === "any"} onChange={(any) => set({ assets: any ? "any" : data.book.map(h => h.asset) })}>Allow any asset</Toggle>
        <div className="flex flex-wrap gap-4">
          {data.book.map((h) => (
            <Toggle
              key={h.asset}
              checked={allowsAsset(draft, h.asset)}
              onChange={(on) => {
                const assets = draft.assets === "any" ? data.book.map(h => h.asset) : draft.assets;
                set({ assets: on ? [...new Set([...assets, h.asset])] : assets.filter(a => a !== h.asset) });
              }}
            >
              {h.symbol}
            </Toggle>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-3 border-t pt-5">
        <h3 className="text-lg font-medium">Caps per asset</h3>
        <p className="text-sm text-muted-foreground">Per-asset reset timing is not verified on the deployed provider. Pinned provider tests use UTC calendar hours and days. Blank means no cap in that period.</p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] text-sm">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="pb-2 font-normal">Asset</th>
                {WINDOWS.map(([window, label]) => (
                  <th key={window} className="pb-2 font-normal">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.book
                .filter((h) => allowsAsset(draft, h.asset))
                .map((h) => (
                  <tr key={h.asset}>
                    <td className="py-1 pr-3">{h.symbol}</td>
                    {WINDOWS.map(([window, label]) => (
                      <td key={window} className="py-1 pr-2">
                        <input
                          className={`${input} w-full`}
                          inputMode="decimal"
                          name={`${h.asset}-${window}`} autoComplete="off"
                          aria-label={`${h.symbol} ${label.toLowerCase()} cap`}
                          aria-invalid={fieldError(`${h.symbol} ${label.toLowerCase()}`)}
                          aria-describedby={fieldError(`${h.symbol} ${label.toLowerCase()}`) ? `${window}-${h.asset}-error` : undefined}
                          placeholder="No cap"
                          value={draft.caps[window][h.asset] ?? ""}
                          onChange={(e) =>
                            set({ caps: { ...draft.caps, [window]: { ...draft.caps[window], [h.asset]: e.target.value } } })
                          }
                        />
                        {fieldError(`${h.symbol} ${label.toLowerCase()}`) && <p id={`${window}-${h.asset}-error`} className="mt-1 text-destructive-muted-foreground">Enter a positive amount with up to {h.decimals} decimal places, or leave blank for no cap.</p>}
                      </td>
                    ))}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 border-t pt-5 sm:grid-cols-4">
        {BUDGET.map(([key, label]) => (
          <label key={key} className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">USD budget {label}</span>
            <input
              className={input}
              inputMode="decimal"
              placeholder="No cap"
              name={key} autoComplete="off"
              aria-invalid={fieldError(`the budget ${label}`)}
              aria-describedby={fieldError(`the budget ${label}`) ? `${key}-error` : undefined}
              value={draft.budget[key]}
              onChange={(e) => set({ budget: { ...draft.budget, [key]: e.target.value } })}
            />
            {fieldError(`the budget ${label}`) && <span id={`${key}-error`} className="text-destructive-muted-foreground">Enter a nonnegative decimal amount, or leave blank for no cap.</span>}
          </label>
        ))}
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Actions an hour</span>
          <input className={input} name="actions-per-hour" autoComplete="off" aria-invalid={fieldError("actions an hour")} aria-describedby={fieldError("actions an hour") ? "rate-error" : undefined} inputMode="numeric" placeholder="No cap" value={draft.rate} onChange={(e) => set({ rate: e.target.value })} />
          {fieldError("actions an hour") && <span id="rate-error" className="text-destructive-muted-foreground">Enter a positive whole number, or leave blank for no cap.</span>}
        </label>
      </div>

      <div className="flex flex-col gap-3 border-t pt-5">
        <ErrorBox error={stale ? "The policy changed or is unavailable. Your draft is preserved. Compare it with the current policy before signing." : undefined} />
        {stale && <Button variant="outline" disabled={!currentPolicy || action.busy} onClick={() => {
          setBaseline({ draft: draftOf(policy, data.book), policy: currentPolicy });
          setReviewing(false);
        }}>Compare draft with current policy</Button>}
        <ErrorBox error={invalid ? `Check ${invalid}. Correct the highlighted field before reviewing.` : undefined} />
        {reviewing && !stale && "changes" in result && (
          <div role="status" className="flex flex-col gap-2 text-sm">
            <span className="text-muted-foreground">
              {viaDao ? "The DAO will be asked to sign these changes:" : "You will sign these changes:"}
            </span>
            <ul className="flex flex-col gap-1">
              {lines.map((line) => (
                <li key={line} className="font-mono text-xs">
                  {line}
                </li>
              ))}
            </ul>
          </div>
        )}
        <ErrorBox error={action.error} />
        <div className="flex flex-wrap items-center gap-3">
          {reviewing && !stale && "changes" in result ? (
            <Button
              disabled={action.busy || !canSign}
              onClick={async () => {
                if (stale || !baseline.policy || !canSign) return;
                if (await action.run({ type: "policy_update", changes: result.changes, expectedPolicy: baseline.policy })) onDone();
              }}
            >
              {action.busy && <Spinner />} {viaDao ? "Propose in Trezu" : "Sign update"}
            </Button>
          ) : (
            <Button type="submit" disabled={action.busy || !dirty || stale || !canSign}>
              Review changes
            </Button>
          )}
          <Button variant="ghost" disabled={action.busy} onClick={cancel}>
            Cancel
          </Button>
          <span role="status" className="text-sm text-muted-foreground">{action.label}</span>
        </div>
        {action.digest && (
          <p className="text-sm text-muted-foreground">
            Mandate being signed: <span className="break-all font-mono text-xs text-foreground">{action.digest}</span>
          </p>
        )}
      </div>
      </form>
    </Card>
  );
}
