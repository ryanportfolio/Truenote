import { useCallback, useEffect, useId, useState } from "react";
import { KeyRound, Plus, RefreshCw } from "lucide-react";
import { RelativeTime } from "@/components/RelativeTime";
import {
  addPasskey,
  generateRecoveryCodes,
  getMfaStatus,
  removePasskey
} from "@/lib/api";
import type { MfaStatusResponse, PasskeySummary } from "@/types/api";
import { PasswordConfirmForm } from "./PasswordConfirmForm";
import { RecoveryCodesReveal } from "./RecoveryCodesReveal";

const DESTRUCTIVE_SMALL =
  "rounded-full border border-destructive/40 px-3 py-1 text-xs text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

type Action =
  | { kind: "add" }
  | { kind: "remove"; passkey: PasskeySummary }
  | { kind: "codes" }
  | null;

interface EmergencyAccessCardProps {
  email: string;
}

/**
 * Second factor of the signed-in super_user's local password sign-in:
 * passkeys and single-use recovery codes. With LOCAL_LOGIN_MODE=break_glass
 * the emergency account cannot sign in with a password until it has a
 * passkey.
 */
export function EmergencyAccessCard({ email }: EmergencyAccessCardProps): JSX.Element {
  const nameId = useId();
  const [status, setStatus] = useState<MfaStatusResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [action, setAction] = useState<Action>(null);
  const [passkeyName, setPasskeyName] = useState("");
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const [notice, setNotice] = useState("");

  const load = useCallback(async (): Promise<void> => {
    setLoadError(null);
    try {
      setStatus(await getMfaStatus());
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Sign-in factors could not load");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function open(next: Action): void {
    setAction(next);
    setNotice("");
    if (next?.kind === "add") setPasskeyName("");
  }

  async function submitAdd(password: string): Promise<void> {
    const added = await addPasskey(password, passkeyName);
    setAction(null);
    setNotice(`Passkey "${added.name ?? "Passkey"}" added.`);
    await load();
  }

  async function submitRemove(passkey: PasskeySummary, password: string): Promise<void> {
    await removePasskey(passkey.id, password);
    setAction(null);
    setNotice(`Passkey "${passkey.name ?? "Passkey"}" removed.`);
    await load();
  }

  async function submitCodes(password: string): Promise<void> {
    const codes = await generateRecoveryCodes(password);
    setAction(null);
    setNewCodes(codes);
    setNotice(`${codes.length} new recovery codes generated.`);
    await load();
  }

  const busy = action !== null;

  return (
    <section
      className="overflow-hidden rounded-lg border border-border bg-card shadow-card"
      aria-labelledby="emergency-access-heading"
      data-emergency-access
    >
      <div className="flex gap-3 p-5">
        <span className="mt-0.5 self-start rounded-full bg-muted p-2 text-foreground">
          <KeyRound className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 id="emergency-access-heading" className="text-xl font-semibold tracking-tight">
            Emergency sign-in
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Second factor for password sign-in to <span className="break-all font-medium text-foreground">{email}</span>.
            When password sign-in is limited to emergency access, this account cannot sign in
            with its password until it has a passkey.
          </p>
        </div>
      </div>

      <p role="status" className="sr-only">
        {notice}
      </p>

      {loadError ? (
        <div className="flex flex-wrap items-center gap-3 border-t border-border px-5 py-4">
          <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {loadError}
          </p>
          <button
            type="button"
            className="btn-whisper inline-flex items-center gap-1.5 px-3 py-1.5 text-sm"
            onClick={() => void load()}
          >
            <RefreshCw className="h-4 w-4" aria-hidden />
            Retry
          </button>
        </div>
      ) : !status ? (
        <div role="status" className="space-y-3 border-t border-border px-5 py-4">
          <div className="skeleton h-4 w-40" />
          <div className="skeleton h-10 w-full max-w-xl" />
          <span className="sr-only">Loading sign-in factors…</span>
        </div>
      ) : (
        <>
          {!status.passkeyAvailable ? (
            <p className="border-t border-border bg-warning/15 px-5 py-3 text-sm text-warning-foreground">
              Passkeys are not configured on this server. Set WEBAUTHN_RP_ID and WEBAUTHN_ORIGINS
              (or APP_BASE_URL) and redeploy before adding one.
            </p>
          ) : null}

          <div className="border-t border-border px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-base font-semibold">Passkeys</h3>
              <button
                type="button"
                className="btn-whisper inline-flex items-center gap-1.5 px-3 py-1.5 text-sm"
                onClick={() => open({ kind: "add" })}
                disabled={busy || !status.passkeyAvailable}
                data-add-passkey
              >
                <Plus className="h-4 w-4" aria-hidden />
                Add passkey
              </button>
            </div>

            {status.passkeys.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">
                No passkeys yet. Add one, then generate recovery codes as the fallback.
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-border rounded-lg border border-border" data-passkey-list>
                {status.passkeys.map((passkey) => (
                  <li key={passkey.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="break-words text-sm font-medium">{passkey.name ?? "Passkey"}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          Added <RelativeTime iso={passkey.createdAt} />
                          {" · "}
                          {passkey.lastUsedAt ? (
                            <>
                              Last used <RelativeTime iso={passkey.lastUsedAt} />
                            </>
                          ) : (
                            "Not used yet"
                          )}
                        </p>
                      </div>
                      <button
                        type="button"
                        className={DESTRUCTIVE_SMALL}
                        onClick={() => open({ kind: "remove", passkey })}
                        disabled={busy}
                        aria-label={`Remove passkey ${passkey.name ?? ""}`.trim()}
                      >
                        Remove
                      </button>
                    </div>
                    {action?.kind === "remove" && action.passkey.id === passkey.id ? (
                      <PasswordConfirmForm
                        description={
                          status.passkeys.length === 1
                            ? "Remove your only passkey? Password sign-in to this account then skips the second factor. While password sign-in is limited to emergency access, the last passkey cannot be removed."
                            : `Remove "${passkey.name ?? "Passkey"}"? It will no longer sign in to this account.`
                        }
                        submitLabel="Remove passkey"
                        pendingLabel="Removing…"
                        destructive
                        onSubmit={(password) => submitRemove(passkey, password)}
                        onCancel={() => setAction(null)}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            )}

            {action?.kind === "add" ? (
              <PasswordConfirmForm
                description="After your password, the browser asks for a passkey: this device, a phone, or a security key."
                submitLabel="Continue"
                pendingLabel="Waiting for passkey…"
                onSubmit={submitAdd}
                onCancel={() => setAction(null)}
              >
                <div className="grid gap-1.5">
                  <label htmlFor={nameId} className="text-sm font-medium">
                    Passkey name <span className="font-normal text-muted-foreground">(optional)</span>
                  </label>
                  <input
                    id={nameId}
                    name="passkey-name"
                    type="text"
                    autoComplete="off"
                    maxLength={60}
                    placeholder="Work laptop"
                    value={passkeyName}
                    onChange={(e) => setPasskeyName(e.target.value)}
                    className="w-full max-w-sm rounded-md border border-input bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                  />
                </div>
              </PasswordConfirmForm>
            ) : null}
          </div>

          <div className="border-t border-border px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold">Recovery codes</h3>
                <p className="mt-0.5 text-sm text-muted-foreground" data-recovery-count>
                  {status.unusedRecoveryCodes === 0
                    ? "No unused codes."
                    : `${status.unusedRecoveryCodes} unused ${status.unusedRecoveryCodes === 1 ? "code" : "codes"}.`}
                </p>
              </div>
              <button
                type="button"
                className="btn-whisper px-3 py-1.5 text-sm"
                onClick={() => {
                  setNewCodes(null);
                  open({ kind: "codes" });
                }}
                disabled={busy}
                data-generate-codes
              >
                Generate new codes
              </button>
            </div>

            {action?.kind === "codes" ? (
              <PasswordConfirmForm
                description={
                  status.unusedRecoveryCodes > 0
                    ? "Generating 10 new codes replaces the ones you have now. The old codes stop working."
                    : "You'll see 10 codes once. Keep them somewhere safe, away from this device."
                }
                submitLabel="Generate codes"
                pendingLabel="Generating…"
                onSubmit={submitCodes}
                onCancel={() => setAction(null)}
              />
            ) : null}

            {newCodes ? <RecoveryCodesReveal codes={newCodes} onDone={() => setNewCodes(null)} /> : null}
          </div>
        </>
      )}
    </section>
  );
}
