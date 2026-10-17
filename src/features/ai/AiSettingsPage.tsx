import { useEffect, useId, useMemo, useState } from "react";
import { Button } from "../../components/Button";
import { Checkbox, Input, Select } from "../../components/Input";
import { Check } from "../../components/icons";
import styles from "./AiSettings.module.css";
import settingsStyles from "../../shell/SettingsDialog.module.css";
import { aiModels, aiSecretClear, aiSecretSet, aiTestProvider } from "./api";
import type { AiSettings, ModelInfo, ProviderConfig } from "./api";
import { CopilotPanel } from "./CopilotPanel";
import { openExternal } from "./external";
import { useCopilot } from "./copilotStore";
import {
  BUILTIN,
  COPILOT,
  defaultProvider,
  isCustom,
  isPlainHttpRemote,
  shortModel,
} from "./providers";
import type { Entry } from "./providers";
import { isConfigured, useAiSettings } from "./settingsStore";

type Tone = "ok" | "wait" | "off";

const TONE_COLOR: Record<Tone, string> = {
  ok: "var(--success)",
  wait: "var(--accent)",
  off: "var(--text-dim)",
};

function Status({ tone, children }: { tone: Tone; children: string }) {
  return (
    <span className={styles.status} style={{ color: TONE_COLOR[tone] }}>
      <span className={styles.dot} />
      {children}
    </span>
  );
}

function Logo({ entry }: { entry: Entry }) {
  return (
    <span className={styles.logo} style={{ background: entry.color }} aria-hidden="true">
      {entry.mark}
    </span>
  );
}

/** Settings › AI assistant (design/canvas/AIProviders.dc.html). */
export function AiSettingsPage() {
  const { settings, secrets, loaded, load, save, patch } = useAiSettings();
  const copilot = useCopilot();
  const [selected, setSelected] = useState("copilot");
  const [adding, setAdding] = useState<string | null>(null);
  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const customs = settings.providers.filter(isCustom);
  const configured = settings.providers.filter((p) => isConfigured(p, secrets));
  const copilotIn = copilot.phase === "in";

  const rows: { entry: Entry; status: string; tone: Tone }[] = [
    {
      entry: COPILOT,
      ...(copilot.phase === "in"
        ? { status: "Signed in", tone: "ok" as const }
        : copilot.phase === "pending" ||
            copilot.phase === "downloading" ||
            copilot.phase === "starting"
          ? { status: "Waiting…", tone: "wait" as const }
          : { status: "Not signed in", tone: "off" as const }),
    },
    ...(["anthropic", "openai"] as const).map((id) => {
      const saved = settings.providers.find((p) => p.id === id);
      const ok = !!saved && isConfigured(saved, secrets);
      return {
        entry: BUILTIN[id],
        status: ok ? "Connected" : "Not set up",
        tone: (ok ? "ok" : "off") as Tone,
      };
    }),
    ...customs.map((p) => ({
      entry: {
        id: p.id,
        name: p.name || "Custom endpoint",
        sub: "OpenAI- or Anthropic-compatible",
        mark: "{ }",
        color: "var(--ai-custom)",
      },
      status: isConfigured(p, secrets) ? "Connected" : "Not set up",
      tone: (isConfigured(p, secrets) ? "ok" : "off") as Tone,
    })),
    ...(customs.length === 0 && adding === null
      ? [
          {
            entry: {
              id: "custom-new",
              name: "Custom endpoint",
              sub: "OpenAI- or Anthropic-compatible",
              mark: "{ }",
              color: "var(--ai-custom)",
            },
            status: "Not set up",
            tone: "off" as Tone,
          },
        ]
      : []),
    ...(adding !== null
      ? [
          {
            entry: {
              id: adding,
              name: "Custom endpoint",
              sub: "New endpoint",
              mark: "{ }",
              color: "var(--ai-custom)",
            },
            status: "Not set up",
            tone: "off" as Tone,
          },
        ]
      : []),
    (() => {
      const saved = settings.providers.find((p) => p.id === "local");
      const ok = !!saved && isConfigured(saved, secrets);
      return {
        entry: BUILTIN.local,
        status: ok ? "Connected" : "Not set up",
        tone: (ok ? "ok" : "off") as Tone,
      };
    })(),
  ];

  const addEndpoint = () => {
    const next = defaultProvider(
      "custom",
      settings.providers.map((p) => p.id),
    ).id;
    setAdding(next);
    setSelected(next);
  };

  const current = selected === "custom-new" ? "custom-new" : selected;

  return (
    <>
      <div className={styles.top}>
        <div>
          <h2 className={settingsStyles.title}>AI assistant</h2>
          <p className={settingsStyles.lede}>
            Bring your own model. Sign in to GitHub Copilot, or point Clew at Claude, OpenAI or any
            compatible endpoint. Keys stay in your system keychain.
          </p>
        </div>
        <Checkbox
          label="Enable AI features"
          checked={settings.enabled}
          onChange={(e) => void patch({ enabled: e.target.checked })}
        />
      </div>

      <div className={styles.cols}>
        <div className={styles.list} role="group" aria-label="Providers">
          <h3 className={styles.h}>PROVIDERS</h3>
          {rows.map(({ entry, status, tone }) => (
            <button
              key={entry.id}
              type="button"
              className={styles.prov}
              aria-pressed={entry.id === current}
              onClick={() => setSelected(entry.id)}
            >
              <Logo entry={entry} />
              <span className={styles.provText}>
                {entry.name}
                <small>{entry.sub}</small>
              </span>
              <Status tone={tone}>{status}</Status>
            </button>
          ))}
          {customs.length > 0 && adding === null ? (
            <button type="button" className={styles.addMore} onClick={addEndpoint}>
              + Add another endpoint
            </button>
          ) : null}
        </div>

        <div className={styles.detail}>
          {current === "copilot" ? (
            <CopilotDetail />
          ) : (
            <ProviderForm
              key={current}
              id={
                current === "custom-new"
                  ? defaultProvider(
                      "custom",
                      settings.providers.map((p) => p.id),
                    ).id
                  : current
              }
              onSaved={(id) => {
                setAdding(null);
                setSelected(id);
              }}
              onRemoved={() => {
                setAdding(null);
                setSelected("copilot");
              }}
              onCancelAdd={() => {
                setAdding(null);
                setSelected("copilot");
              }}
              isNew={adding !== null && current === adding}
            />
          )}
        </div>
      </div>

      <div className={styles.bottom}>
        <Routing
          settings={settings}
          configured={configured}
          copilotIn={copilotIn}
          onChange={(routing) => void save({ ...settings, routing })}
        />
        <Privacy settings={settings} onChange={(privacy) => void save({ ...settings, privacy })} />
      </div>
    </>
  );
}

function CopilotDetail() {
  const { settings, patch } = useAiSettings();
  return (
    <>
      <div className={styles.head}>
        <Logo entry={COPILOT} />
        <div>
          <div className={styles.headTitle}>GitHub Copilot</div>
          <div className={styles.headSub}>
            Inline completions and chat with your Copilot subscription
          </div>
        </div>
      </div>
      <CopilotPanel />
      <Checkbox
        label="Inline completions in the SQL editor"
        description="Ghost text as you type; Tab accepts, Esc dismisses."
        checked={settings.copilot.inline}
        onChange={(e) => void patch({ copilot: { ...settings.copilot, inline: e.target.checked } })}
      />
      <Checkbox
        label="Use Copilot for chat too"
        description="Not available yet: the Copilot component doesn't offer chat to other apps in this version."
        checked={false}
        disabled
        onChange={() => {}}
      />
    </>
  );
}

function ProviderForm({
  id,
  isNew,
  onSaved,
  onRemoved,
  onCancelAdd,
}: {
  id: string;
  isNew: boolean;
  onSaved: (id: string) => void;
  onRemoved: () => void;
  onCancelAdd: () => void;
}) {
  const { settings, secrets, save, setSecretPresent } = useAiSettings();
  const saved = settings.providers.find((p) => p.id === id);
  const [cfg, setCfg] = useState<ProviderConfig>(
    () =>
      saved ??
      defaultProvider(
        id,
        settings.providers.map((p) => p.id),
      ),
  );
  const [key, setKey] = useState("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [plainOk, setPlainOk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uid = useId();
  const builtin = BUILTIN[cfg.id];
  const custom = isCustom(cfg);
  const local = cfg.kind === "local";
  const keyed = cfg.kind === "anthropic" || cfg.kind === "openai";
  const needsSecret = cfg.kind !== "local" && cfg.auth !== "none";
  const hasSecret = !!secrets[cfg.id];
  const plainHttp = custom && isPlainHttpRemote(cfg.baseUrl);
  const set = (patch: Partial<ProviderConfig>) => {
    setCfg((c) => ({ ...c, ...patch }));
    setTest(null);
    setError(null);
  };

  // Offer the models of a provider that is already set up.
  useEffect(() => {
    if (!saved || (needsSecret && !hasSecret)) return;
    let live = true;
    void aiModels(saved)
      .then((m) => live && setModels(m))
      .catch(() => {});
    return () => {
      live = false;
    };
    // Once per opened provider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const message = (e: unknown) => (e as { message?: string }).message ?? "Something went wrong";

  const runTest = async () => {
    setBusy("test");
    setTest(null);
    try {
      const r = await aiTestProvider(cfg, key || undefined);
      setTest({ ok: r.ok, message: r.message });
      aiModels(cfg, key || undefined)
        .then(setModels)
        .catch(() => {});
    } catch (e) {
      setTest({ ok: false, message: message(e) });
    } finally {
      setBusy(null);
    }
  };

  const missing = (() => {
    if (custom && !cfg.name.trim()) return "Give the endpoint a display name";
    if (custom && !cfg.baseUrl.trim()) return "Enter the base URL";
    if (custom && !cfg.model.trim()) return "Enter the model ID";
    if (local && !cfg.baseUrl.trim()) return "Enter the endpoint";
    if (needsSecret && !key && !hasSecret) return "Enter the API key";
    if (cfg.auth === "header" && custom && !cfg.authHeader.trim()) return "Enter the header name";
    if (plainHttp && !plainOk) return "Confirm that the token may be sent unencrypted";
    return null;
  })();

  const doSave = async () => {
    if (missing) {
      setError(missing);
      return;
    }
    setBusy("save");
    try {
      if (key) {
        await aiSecretSet(cfg.id, key);
        setSecretPresent(cfg.id, true);
        setKey("");
      }
      const wasConfigured = settings.providers.some((p) => isConfigured(p, secrets));
      const providers = saved
        ? settings.providers.map((p) => (p.id === cfg.id ? cfg : p))
        : [...settings.providers, cfg];
      // The first provider set up switches the features on; after that the choice is the user's.
      await save({ ...settings, providers, enabled: settings.enabled || !wasConfigured });
      onSaved(cfg.id);
      aiModels(cfg)
        .then(setModels)
        .catch(() => {});
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    await aiSecretClear(cfg.id).catch(() => {});
    setSecretPresent(cfg.id, false);
    await save({ ...settings, providers: settings.providers.filter((p) => p.id !== cfg.id) });
    onRemoved();
  };

  const modelOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: ModelInfo[] = [];
    for (const m of [...(cfg.model ? [{ id: cfg.model, name: cfg.model }] : []), ...models]) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        out.push(m);
      }
    }
    return out;
  }, [cfg.model, models]);

  const title = custom ? cfg.name || "Custom endpoint" : (builtin?.name ?? cfg.name);
  const blurb = custom
    ? "Azure OpenAI, OpenRouter, LiteLLM, vLLM, a company gateway…"
    : (builtin?.blurb ?? "");
  const entry: Entry = builtin ?? {
    id: cfg.id,
    name: title,
    sub: "",
    mark: "{ }",
    color: "var(--ai-custom)",
  };

  return (
    <>
      <div className={styles.head}>
        <Logo entry={entry} />
        <div>
          <div className={styles.headTitle}>{title}</div>
          <div className={styles.headSub}>{blurb}</div>
        </div>
      </div>

      {custom ? (
        <>
          <div className={styles.grid}>
            <div className={styles.fld}>
              <label htmlFor={`${uid}-name`}>Display name</label>
              <Input
                id={`${uid}-name`}
                dialog
                value={cfg.name}
                onChange={(e) => set({ name: e.target.value })}
              />
            </div>
            <div className={styles.fld}>
              <label htmlFor={`${uid}-api`}>API style</label>
              <Select
                id={`${uid}-api`}
                value={cfg.kind}
                onChange={(e) => set({ kind: e.target.value as ProviderConfig["kind"] })}
              >
                <option value="custom_openai">OpenAI-compatible (chat/completions)</option>
                <option value="custom_anthropic">Anthropic-compatible (messages)</option>
              </Select>
            </div>
          </div>
          <div className={styles.fld}>
            <label htmlFor={`${uid}-url`}>Base URL</label>
            <Input
              id={`${uid}-url`}
              dialog
              mono
              placeholder="https://llm.internal.example.com/v1"
              value={cfg.baseUrl}
              onChange={(e) => set({ baseUrl: e.target.value })}
            />
          </div>
          {plainHttp ? (
            <div className={styles.warn} role="alert">
              <span>
                This address uses http://, so the token would be sent unencrypted to another
                machine.
              </span>
              <Checkbox
                label="Save it anyway"
                checked={plainOk}
                onChange={(e) => setPlainOk(e.target.checked)}
              />
            </div>
          ) : null}
          <div className={styles.grid}>
            <div className={styles.fld}>
              <label htmlFor={`${uid}-auth`}>Authentication</label>
              <Select
                id={`${uid}-auth`}
                value={cfg.auth}
                onChange={(e) => set({ auth: e.target.value as ProviderConfig["auth"] })}
              >
                <option value="bearer">Bearer token</option>
                <option value="header">Custom header</option>
                <option value="none">None</option>
              </Select>
            </div>
            {cfg.auth === "header" ? (
              <div className={styles.fld}>
                <label htmlFor={`${uid}-hdr`}>Header name</label>
                <Input
                  id={`${uid}-hdr`}
                  dialog
                  mono
                  placeholder="api-key"
                  value={cfg.authHeader}
                  onChange={(e) => set({ authHeader: e.target.value })}
                />
              </div>
            ) : null}
            {cfg.auth !== "none" ? (
              <div className={styles.fld}>
                <label htmlFor={`${uid}-tok`}>
                  {cfg.auth === "header" ? "Header value" : "Token"}
                </label>
                <Input
                  id={`${uid}-tok`}
                  dialog
                  mono
                  type="password"
                  autoComplete="off"
                  placeholder={hasSecret ? "•••••••• (saved)" : ""}
                  value={key}
                  onChange={(e) => {
                    setKey(e.target.value);
                    setTest(null);
                  }}
                />
              </div>
            ) : null}
          </div>
          <div className={styles.fld}>
            <label htmlFor={`${uid}-model`}>Model ID</label>
            <Input
              id={`${uid}-model`}
              dialog
              mono
              placeholder="as your endpoint names it"
              value={cfg.model}
              onChange={(e) => set({ model: e.target.value })}
            />
          </div>
        </>
      ) : null}

      {keyed ? (
        <>
          <div className={styles.fld}>
            <label htmlFor={`${uid}-key`}>API key</label>
            <div className={styles.pair}>
              <Input
                id={`${uid}-key`}
                dialog
                mono
                type="password"
                autoComplete="off"
                placeholder={hasSecret ? "•••••••• (saved)" : ""}
                value={key}
                onChange={(e) => {
                  setKey(e.target.value);
                  setTest(null);
                }}
              />
              <Button
                variant="default"
                onClick={() =>
                  void navigator.clipboard
                    .readText()
                    .then((t) => setKey(t.trim()))
                    .catch(() => {})
                }
              >
                Paste
              </Button>
            </div>
            <span className={styles.hint}>
              Saved in the system keychain.{" "}
              <button
                type="button"
                className={styles.link}
                onClick={() =>
                  void openExternal(
                    cfg.kind === "anthropic"
                      ? "https://console.anthropic.com/settings/keys"
                      : "https://platform.openai.com/api-keys",
                  )
                }
              >
                Where do I get a key?
              </button>
            </span>
          </div>
          <div className={styles.grid}>
            <div className={styles.fld}>
              <label htmlFor={`${uid}-model`}>Chat model</label>
              <Select
                id={`${uid}-model`}
                value={cfg.model}
                onChange={(e) => set({ model: e.target.value })}
              >
                {modelOptions.length === 0 ? (
                  <option value="">Choose after adding a key</option>
                ) : null}
                {modelOptions.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name === m.id ? shortModel(m.id) : m.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className={styles.fld}>
              <label htmlFor={`${uid}-base`}>Base URL</label>
              <Input
                id={`${uid}-base`}
                dialog
                mono
                value={cfg.baseUrl}
                onChange={(e) => set({ baseUrl: e.target.value })}
              />
            </div>
          </div>
        </>
      ) : null}

      {local ? (
        <>
          <div className={styles.fld}>
            <label htmlFor={`${uid}-lurl`}>Endpoint</label>
            <Input
              id={`${uid}-lurl`}
              dialog
              mono
              value={cfg.baseUrl}
              onChange={(e) => set({ baseUrl: e.target.value })}
            />
          </div>
          <div className={styles.fld}>
            <label htmlFor={`${uid}-lmodel`}>Model</label>
            <Select
              id={`${uid}-lmodel`}
              value={cfg.model}
              onChange={(e) => set({ model: e.target.value })}
            >
              {modelOptions.length === 0 ? <option value="">Detected on test…</option> : null}
              {modelOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          </div>
        </>
      ) : null}

      <div className={styles.actions}>
        <Button variant="default" disabled={busy !== null} onClick={() => void runTest()}>
          {busy === "test" ? "Testing…" : "Test connection"}
        </Button>
        {test ? (
          <span className={test.ok ? styles.ok : styles.bad} role="status">
            {test.ok ? <Check size={14} /> : null}
            {test.message}
          </span>
        ) : null}
        {error ? (
          <span className={styles.bad} role="alert">
            {error}
          </span>
        ) : null}
        <span className={styles.grow} />
        {isNew ? (
          <Button variant="ghost" onClick={onCancelAdd}>
            Cancel
          </Button>
        ) : null}
        {saved ? (
          <Button variant="ghost" onClick={() => void remove()}>
            Remove
          </Button>
        ) : null}
        <Button variant="primary" disabled={busy !== null} onClick={() => void doSave()}>
          Save
        </Button>
      </div>
    </>
  );
}

function Routing({
  settings,
  configured,
  copilotIn,
  onChange,
}: {
  settings: AiSettings;
  configured: ProviderConfig[];
  copilotIn: boolean;
  onChange: (r: AiSettings["routing"]) => void;
}) {
  const r = settings.routing;
  const options = configured.map((p) => ({
    id: p.id,
    label: p.model ? `${p.name} · ${shortModel(p.model)}` : p.name,
  }));
  const withCopilot = copilotIn
    ? [{ id: "copilot", label: "GitHub Copilot" }, ...options]
    : options;
  const chatValue = r.chat ?? configured[0]?.id ?? "";
  const row = (
    label: string,
    aria: string,
    value: string,
    choices: { id: string; label: string }[],
    first: { id: string; label: string } | null,
    set: (v: string | null) => void,
  ) => (
    <div className={styles.route}>
      <span>{label}</span>
      <Select aria-label={aria} value={value} onChange={(e) => set(e.target.value || null)}>
        {first ? <option value={first.id}>{first.label}</option> : null}
        {choices.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </Select>
    </div>
  );
  return (
    <div role="group" aria-label="Use for">
      <h3 className={styles.h}>USE FOR</h3>
      {row(
        "Inline completions",
        "Inline completions provider",
        r.inline ?? "",
        withCopilot,
        { id: "", label: "Off" },
        (v) => onChange({ ...r, inline: v }),
      )}
      {row(
        "Chat panel",
        "Chat provider",
        chatValue,
        configured.length === 0
          ? []
          : [
              ...(copilotIn && settings.copilot.chat
                ? [{ id: "copilot", label: "GitHub Copilot" }]
                : []),
              ...options,
            ],
        configured.length === 0 ? { id: "", label: "Not set up" } : null,
        (v) => onChange({ ...r, chat: v }),
      )}
      {row(
        "Fix / explain errors",
        "Error assistant provider",
        r.fix ?? "",
        options,
        { id: "", label: "Same as chat" },
        (v) => onChange({ ...r, fix: v }),
      )}
      {row(
        "Natural language → SQL",
        "SQL generation provider",
        r.nlSql ?? "",
        options,
        { id: "", label: "Same as chat" },
        (v) => onChange({ ...r, nlSql: v }),
      )}
    </div>
  );
}

function Privacy({
  settings,
  onChange,
}: {
  settings: AiSettings;
  onChange: (p: AiSettings["privacy"]) => void;
}) {
  const p = settings.privacy;
  const id = useId();
  return (
    <div className={styles.privacy}>
      <h3 className={styles.h}>WHAT THE AI CAN SEE</h3>
      <Checkbox
        label="Schema: table, column and index names and types"
        checked={p.schema}
        onChange={(e) => onChange({ ...p, schema: e.target.checked })}
      />
      <Checkbox
        label="The SQL in the editor and error messages"
        checked={p.sql}
        onChange={(e) => onChange({ ...p, sql: e.target.checked })}
      />
      <Checkbox
        label="Sample rows from results"
        description="Up to 20 rows, only when you attach them to a message."
        checked={p.rows}
        onChange={(e) => onChange({ ...p, rows: e.target.checked })}
      />
      <div className={styles.fld} style={{ maxWidth: 360 }}>
        <label htmlFor={`${id}-prod`}>On Production connections</label>
        <Select
          id={`${id}-prod`}
          value={p.production}
          onChange={(e) =>
            onChange({ ...p, production: e.target.value as AiSettings["privacy"]["production"] })
          }
        >
          <option value="schema_only">Schema only, never row data</option>
          <option value="disabled">Disable AI entirely</option>
          <option value="same_as_others">Same as other connections</option>
        </Select>
      </div>
      <p className={styles.note}>
        Hostnames, usernames and passwords are never sent. AI-written SQL is never run without you
        pressing Run.
      </p>
    </div>
  );
}
