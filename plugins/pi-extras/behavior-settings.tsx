import { useId, type ReactNode } from "react";
import type { PiSettings } from "./pi-settings";

/**
 * The global Pi settings BB does not pass when it starts a thread, so Pi's
 * values are what a BB thread actually runs with. Every control is tri-state: an
 * empty choice leaves the key out of settings.json and hands the decision back to
 * Pi, whose default is shown as a placeholder rather than written out.
 *
 * Deliberately absent, because BB handles them itself or they cannot fire:
 * BB passes the model, reasoning level, session directory, and message queueing,
 * so Pi's own defaults for those never apply to a BB thread.
 */

const FIELD = "w-full rounded-md border border-input bg-background px-2 py-1";
const LABEL = "block text-xs font-medium text-muted-foreground";

function Field({ id, label, help, children }: { id: string; label: string; help?: string; children: ReactNode }) {
  return <div className="space-y-1">
    <label className={LABEL} htmlFor={id}>{label}</label>
    {children}
    {help === undefined ? null : <p className="text-xs text-muted-foreground">{help}</p>}
  </div>;
}

function Switch({
  label,
  help,
  value,
  onChange,
}: {
  label: string;
  help?: string;
  value: boolean | null;
  onChange: (next: boolean | null) => void;
}) {
  const id = useId();
  return <Field id={id} label={label} help={help}>
    <select
      id={id}
      className={FIELD}
      value={value === null ? "pi" : value ? "on" : "off"}
      onChange={(event) => {
        const next = event.target.value;
        onChange(next === "pi" ? null : next === "on");
      }}
    >
      <option value="pi">Pi default</option>
      <option value="on">On</option>
      <option value="off">Off</option>
    </select>
  </Field>;
}

function Count({
  label,
  help,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  help?: string;
  value: number | null;
  placeholder: string;
  onChange: (next: number | null) => void;
}) {
  const id = useId();
  return <Field id={id} label={label} help={help}>
    <input
      id={id}
      className={FIELD}
      type="number"
      min={0}
      step={1}
      value={value === null ? "" : String(value)}
      placeholder={placeholder}
      onChange={(event) => {
        const raw = event.target.value.trim();
        if (raw === "") return onChange(null);
        const parsed = Number(raw);
        onChange(Number.isInteger(parsed) && parsed >= 0 ? parsed : null);
      }}
    />
  </Field>;
}

function Text({
  label,
  help,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  help?: string;
  value: string | null;
  placeholder: string;
  onChange: (next: string | null) => void;
}) {
  const id = useId();
  return <Field id={id} label={label} help={help}>
    <input
      id={id}
      className={FIELD}
      value={value ?? ""}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
    />
  </Field>;
}

function Group({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <fieldset className="space-y-3">
    <legend className="font-medium">{title}</legend>
    <p className="text-xs text-muted-foreground">{description}</p>
    <div className="grid gap-3 sm:grid-cols-2">{children}</div>
  </fieldset>;
}

export function BehaviorSettings({
  draft,
  onChange,
}: {
  draft: PiSettings;
  onChange: (next: PiSettings) => void;
}) {
  const patch = (changes: Partial<PiSettings>) => onChange({ ...draft, ...changes });

  return <div className="space-y-6">
    <p className="text-xs text-muted-foreground">
      BB picks the model, reasoning level, and instructions itself when it starts a thread, so it
      never passes the settings below. Pi&apos;s global values are what a BB thread runs with.
    </p>

    <Group
      title="Long threads"
      description="When Pi summarizes a thread on its own. BB only compacts when you ask it to, so this is what happens once a thread gets long."
    >
      <Switch
        label="Summarize long threads automatically"
        help="Off means Pi never compacts by itself."
        value={draft.compaction.enabled}
        onChange={(enabled) => patch({ compaction: { ...draft.compaction, enabled } })}
      />
      <Count
        label="Context kept free for the reply"
        help="Raise it and long threads compact sooner, leaving Pi more room to answer."
        value={draft.compaction.reserveTokens}
        placeholder="Pi uses 16384"
        onChange={(reserveTokens) => patch({ compaction: { ...draft.compaction, reserveTokens } })}
      />
      <Count
        label="Recent conversation kept after a summary"
        help="Lower it and more of the thread is summarized instead of kept verbatim."
        value={draft.compaction.keepRecentTokens}
        placeholder="Pi uses 20000"
        onChange={(keepRecentTokens) => patch({ compaction: { ...draft.compaction, keepRecentTokens } })}
      />
    </Group>

    <Group
      title="Provider timeouts"
      description="How long Pi waits on a model that has gone quiet."
    >
      <Count
        label="Seconds to wait on a silent provider"
        help="A big prompt on a slow reasoning model can sit quiet for minutes. 0 waits forever."
        value={draft.httpIdleTimeoutMs}
        placeholder="Pi waits 300 (5 min)"
        onChange={(httpIdleTimeoutMs) => patch({ httpIdleTimeoutMs })}
      />
    </Group>

    <Group
      title="Shell"
      description="Pi runs every command the agent asks for through this shell."
    >
      <Text
        label="Shell"
        help="Leave empty for your platform shell. Set it if your login shell breaks agent-written scripts."
        value={draft.shell.shellPath}
        placeholder="platform default"
        onChange={(shellPath) => patch({ shell: { ...draft.shell, shellPath } })}
      />
      <Text
        label="Prefix for every command"
        help="Wrapped in front of each command, for example a sandbox wrapper. Empty means none."
        value={draft.shell.shellCommandPrefix}
        placeholder="none"
        onChange={(shellCommandPrefix) => patch({ shell: { ...draft.shell, shellCommandPrefix } })}
      />
    </Group>

    <Group
      title="Reporting"
      description="What Pi tells Pi's publisher about your install and your use."
    >
      <Switch
        label="Install and update reports"
        help="Anonymous install and update reports, plus attribution headers to some providers. Turning this off does not stop Pi from checking for updates."
        value={draft.telemetry.enableInstallTelemetry}
        onChange={(enableInstallTelemetry) => patch({ telemetry: { ...draft.telemetry, enableInstallTelemetry } })}
      />
      <Switch
        label="Analytics sharing"
        help="Only used by Pi's experimental first-run setup."
        value={draft.telemetry.enableAnalytics}
        onChange={(enableAnalytics) => patch({ telemetry: { ...draft.telemetry, enableAnalytics } })}
      />
    </Group>
  </div>;
}
