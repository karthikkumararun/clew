import { useEffect, useMemo, useState } from "react";
import { Button } from "../../components/Button";
import type { KeyDetail, RedisValue } from "./api";
import { hexStringDump, hexDump, line, prettyJson, quote } from "./format";
import { PromptDialog } from "./Prompts";
import type { KeysRuntime, PageState } from "./runtime";
import styles from "./KeyValue.module.css";

/** Text of one reply cell. */
export function cellText(v: RedisValue | undefined): string {
  if (!v) return "";
  switch (v.kind) {
    case "nil":
      return "(nil)";
    case "int":
    case "double":
    case "bool":
      return String(v.value);
    case "text":
    case "status":
      return v.value;
    case "bytes":
      return `0x${v.hex.slice(0, 64)}${v.hex.length > 64 ? "…" : ""} (${v.len} bytes)`;
    case "error":
      return v.message;
    case "array":
      return v.items.map(cellText).join(", ");
    case "map":
      return v.entries.map(([k, x]) => `${cellText(k)}=${cellText(x)}`).join(", ");
  }
}

interface ViewerProps {
  runtime: KeysRuntime;
  db: number;
  detail: KeyDetail;
  page: PageState;
  readOnly: boolean;
}

function MoreRow({ runtime, db, page }: { runtime: KeysRuntime; db: number; page: PageState }) {
  if (page.next === null) return null;
  return (
    <div className={styles.more}>
      <Button variant="default" disabled={page.loading} onClick={() => void runtime.nextPage(db)}>
        {page.loading
          ? "Loading…"
          : `Load more (${page.rows.length.toLocaleString()}${page.total !== null ? ` of ${page.total.toLocaleString()}` : ""})`}
      </Button>
    </div>
  );
}

type Prompt =
  | {
      kind: "edit";
      title: string;
      label: string;
      initial: string;
      run: (value: string) => string[];
    }
  | {
      kind: "add";
      title: string;
      fields: { id: string; label: string; multiline?: boolean }[];
      run: (v: Record<string, string>) => string[];
    };

function usePrompt(runtime: KeysRuntime, db: number, key: string) {
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const dialog = prompt ? (
    <PromptDialog
      title={prompt.title}
      submitLabel={prompt.kind === "edit" ? "Save" : "Add"}
      fields={
        prompt.kind === "edit"
          ? [
              {
                id: "value",
                label: prompt.label,
                initial: prompt.initial,
                multiline: prompt.initial.includes("\n"),
              },
            ]
          : prompt.fields.map((f) => ({ ...f, required: true }))
      }
      onClose={() => setPrompt(null)}
      onSubmit={async (v) => {
        const lines = prompt.kind === "edit" ? prompt.run(v.value) : prompt.run(v);
        const ok = await runtime.edit(db, key, ...lines);
        if (ok) setPrompt(null);
        else {
          const err = runtime.store.getState().editError;
          if (err) throw new Error(err);
          setPrompt(null); // declined in the confirmation
        }
      }}
    />
  ) : null;
  return { setPrompt, dialog };
}

export function StringViewer({ runtime, db, detail, page, readOnly }: ViewerProps) {
  const cell = page.rows[0]?.[0];
  const binary = cell?.kind === "bytes";
  const original = cell?.kind === "text" ? cell.value : "";
  const [mode, setMode] = useState<"text" | "json" | "hex">("text");
  const [draft, setDraft] = useState(original);
  useEffect(() => setDraft(original), [original, detail.name]);
  const json = useMemo(() => prettyJson(draft), [draft]);
  const cut = page.total !== null && page.total > 1_048_576;
  const dirty = !binary && draft !== original;

  if (!cell)
    return <div className={styles.empty}>{page.loading ? "Loading…" : "Empty value."}</div>;
  const view = binary ? "hex" : mode;
  return (
    <div className={styles.pad}>
      <div className={styles.toolbar} style={{ padding: 0, border: 0 }}>
        <div role="tablist" aria-label="Value format" className={styles.segmented}>
          {(binary ? (["hex"] as const) : (["text", "json", "hex"] as const)).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              className={styles.segment}
              aria-selected={view === m}
              onClick={() => setMode(m)}
            >
              {m === "json" ? "JSON" : m === "hex" ? "Hex" : "Text"}
            </button>
          ))}
        </div>
        <div className={styles.grow} />
        {dirty ? (
          <>
            <Button variant="default" onClick={() => setDraft(original)}>
              Revert
            </Button>
            <Button
              variant="primary"
              disabled={readOnly}
              onClick={() =>
                void runtime.edit(
                  db,
                  detail.name,
                  `SET ${quote(detail.name)} ${quote(draft)} KEEPTTL`,
                )
              }
            >
              Save
            </Button>
          </>
        ) : null}
      </div>
      {cut ? (
        <div className={styles.facts}>
          Showing the first 1 MB of {page.total!.toLocaleString()} bytes.
        </div>
      ) : null}
      {view === "text" ? (
        <textarea
          className={styles.textarea}
          aria-label="Value"
          spellCheck={false}
          readOnly={readOnly || cut}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      ) : view === "json" ? (
        json ? (
          <pre className={styles.pre} aria-label="Value as JSON">
            {json}
          </pre>
        ) : (
          <div className={styles.empty}>This value isn't JSON.</div>
        )
      ) : (
        <pre className={styles.pre} aria-label="Value as hex">
          {binary ? hexStringDump(cell.hex) : hexDump(draft)}
        </pre>
      )}
    </div>
  );
}

function RowActions({
  disabled,
  onEdit,
  onRemove,
  name,
}: {
  disabled: boolean;
  onEdit?: () => void;
  onRemove: () => void;
  name: string;
}) {
  return (
    <td className={styles.actions}>
      {onEdit ? (
        <Button variant="ghost" disabled={disabled} aria-label={`Edit ${name}`} onClick={onEdit}>
          Edit
        </Button>
      ) : null}
      <Button variant="ghost" disabled={disabled} aria-label={`Remove ${name}`} onClick={onRemove}>
        Remove
      </Button>
    </td>
  );
}

export function HashViewer({ runtime, db, detail, page, readOnly }: ViewerProps) {
  const { setPrompt, dialog } = usePrompt(runtime, db, detail.name);
  const key = quote(detail.name);
  return (
    <>
      <div className={styles.toolbar}>
        <Button
          variant="toolbar"
          disabled={readOnly}
          onClick={() =>
            setPrompt({
              kind: "add",
              title: "Add field",
              fields: [
                { id: "field", label: "Field" },
                { id: "value", label: "Value" },
              ],
              run: (v) => [`HSET ${key} ${quote(v.field)} ${quote(v.value)}`],
            })
          }
        >
          Add field
        </Button>
      </div>
      <table className={styles.grid} aria-label="Hash fields">
        <thead>
          <tr>
            <th scope="col" style={{ width: "30%" }}>
              Field
            </th>
            <th scope="col">Value</th>
            <th scope="col" className={styles.actions} />
          </tr>
        </thead>
        <tbody>
          {page.rows.map(([f, v]) => {
            const field = cellText(f);
            return (
              <tr
                key={field}
                onDoubleClick={() =>
                  !readOnly &&
                  setPrompt({
                    kind: "edit",
                    title: `Edit ${field}`,
                    label: "Value",
                    initial: cellText(v),
                    run: (x) => [`HSET ${key} ${quote(field)} ${quote(x)}`],
                  })
                }
              >
                <td>{field}</td>
                <td>{cellText(v)}</td>
                <RowActions
                  name={field}
                  disabled={readOnly}
                  onEdit={() =>
                    setPrompt({
                      kind: "edit",
                      title: `Edit ${field}`,
                      label: "Value",
                      initial: cellText(v),
                      run: (x) => [`HSET ${key} ${quote(field)} ${quote(x)}`],
                    })
                  }
                  onRemove={() => void runtime.edit(db, detail.name, `HDEL ${key} ${quote(field)}`)}
                />
              </tr>
            );
          })}
        </tbody>
      </table>
      <MoreRow runtime={runtime} db={db} page={page} />
      {dialog}
    </>
  );
}

export function ListViewer({ runtime, db, detail, page, readOnly }: ViewerProps) {
  const { setPrompt, dialog } = usePrompt(runtime, db, detail.name);
  const key = quote(detail.name);
  const push = (cmd: "RPUSH" | "LPUSH", title: string) =>
    setPrompt({
      kind: "add",
      title,
      fields: [{ id: "value", label: "Value" }],
      run: (v) => [`${cmd} ${key} ${quote(v.value)}`],
    });
  return (
    <>
      <div className={styles.toolbar}>
        <Button
          variant="toolbar"
          disabled={readOnly}
          onClick={() => push("RPUSH", "Push to the end")}
        >
          Push right
        </Button>
        <Button
          variant="toolbar"
          disabled={readOnly}
          onClick={() => push("LPUSH", "Push to the start")}
        >
          Push left
        </Button>
      </div>
      <table className={styles.grid} aria-label="List elements">
        <thead>
          <tr>
            <th scope="col" style={{ width: 90 }}>
              Index
            </th>
            <th scope="col">Value</th>
            <th scope="col" className={styles.actions} />
          </tr>
        </thead>
        <tbody>
          {page.rows.map(([v], i) => (
            <tr key={i}>
              <td>{i}</td>
              <td>{cellText(v)}</td>
              <RowActions
                name={`element ${i}`}
                disabled={readOnly}
                onEdit={() =>
                  setPrompt({
                    kind: "edit",
                    title: `Edit element ${i}`,
                    label: "Value",
                    initial: cellText(v),
                    run: (x) => [`LSET ${key} ${i} ${quote(x)}`],
                  })
                }
                onRemove={() =>
                  void runtime.edit(db, detail.name, `LREM ${key} 1 ${quote(cellText(v))}`)
                }
              />
            </tr>
          ))}
        </tbody>
      </table>
      <MoreRow runtime={runtime} db={db} page={page} />
      {dialog}
    </>
  );
}

export function SetViewer({ runtime, db, detail, page, readOnly }: ViewerProps) {
  const { setPrompt, dialog } = usePrompt(runtime, db, detail.name);
  const key = quote(detail.name);
  return (
    <>
      <div className={styles.toolbar}>
        <Button
          variant="toolbar"
          disabled={readOnly}
          onClick={() =>
            setPrompt({
              kind: "add",
              title: "Add member",
              fields: [{ id: "member", label: "Member" }],
              run: (v) => [`SADD ${key} ${quote(v.member)}`],
            })
          }
        >
          Add member
        </Button>
      </div>
      <table className={styles.grid} aria-label="Set members">
        <thead>
          <tr>
            <th scope="col">Member</th>
            <th scope="col" className={styles.actions} />
          </tr>
        </thead>
        <tbody>
          {page.rows.map(([m]) => {
            const member = cellText(m);
            return (
              <tr key={member}>
                <td>{member}</td>
                <RowActions
                  name={member}
                  disabled={readOnly}
                  onRemove={() =>
                    void runtime.edit(db, detail.name, `SREM ${key} ${quote(member)}`)
                  }
                />
              </tr>
            );
          })}
        </tbody>
      </table>
      <MoreRow runtime={runtime} db={db} page={page} />
      {dialog}
    </>
  );
}

export function ZSetViewer({ runtime, db, detail, page, readOnly }: ViewerProps) {
  const { setPrompt, dialog } = usePrompt(runtime, db, detail.name);
  const key = quote(detail.name);
  const number = (s: string) => {
    if (!Number.isFinite(Number(s)) || s.trim() === "")
      throw new Error("The score must be a number");
    return s.trim();
  };
  return (
    <>
      <div className={styles.toolbar}>
        <Button
          variant="toolbar"
          disabled={readOnly}
          onClick={() =>
            setPrompt({
              kind: "add",
              title: "Add member",
              fields: [
                { id: "member", label: "Member" },
                { id: "score", label: "Score" },
              ],
              run: (v) => [`ZADD ${key} ${number(v.score)} ${quote(v.member)}`],
            })
          }
        >
          Add member
        </Button>
      </div>
      <table className={styles.grid} aria-label="Sorted set members">
        <thead>
          <tr>
            <th scope="col">Member</th>
            <th scope="col" style={{ width: 160 }}>
              Score
            </th>
            <th scope="col" className={styles.actions} />
          </tr>
        </thead>
        <tbody>
          {page.rows.map(([m, s]) => {
            const member = cellText(m);
            return (
              <tr key={member}>
                <td>{member}</td>
                <td>{cellText(s)}</td>
                <RowActions
                  name={member}
                  disabled={readOnly}
                  onEdit={() =>
                    setPrompt({
                      kind: "edit",
                      title: `Score of ${member}`,
                      label: "Score",
                      initial: cellText(s),
                      run: (x) => [`ZADD ${key} ${number(x)} ${quote(member)}`],
                    })
                  }
                  onRemove={() =>
                    void runtime.edit(db, detail.name, `ZREM ${key} ${quote(member)}`)
                  }
                />
              </tr>
            );
          })}
        </tbody>
      </table>
      <MoreRow runtime={runtime} db={db} page={page} />
      {dialog}
    </>
  );
}

export function StreamViewer({ runtime, db, detail, page, readOnly }: ViewerProps) {
  const { setPrompt, dialog } = usePrompt(runtime, db, detail.name);
  const key = quote(detail.name);
  return (
    <>
      <div className={styles.toolbar}>
        <Button
          variant="toolbar"
          disabled={readOnly}
          onClick={() =>
            setPrompt({
              kind: "add",
              title: "Add entry",
              fields: [
                { id: "field", label: "Field" },
                { id: "value", label: "Value" },
              ],
              run: (v) => [`XADD ${key} * ${quote(v.field)} ${quote(v.value)}`],
            })
          }
        >
          Add entry
        </Button>
        <span className={styles.facts} style={{ border: 0, padding: 0 }}>
          Latest first
        </span>
      </div>
      <table className={styles.grid} aria-label="Stream entries">
        <thead>
          <tr>
            <th scope="col" style={{ width: 180 }}>
              Entry id
            </th>
            <th scope="col">Fields</th>
            <th scope="col" className={styles.actions} />
          </tr>
        </thead>
        <tbody>
          {page.rows.map(([id, fields]) => {
            const entry = cellText(id);
            const pairs =
              fields?.kind === "array"
                ? fields.items.reduce<string[]>((acc, x, i) => {
                    if (i % 2 === 0) acc.push(`${cellText(x)}=${cellText(fields.items[i + 1])}`);
                    return acc;
                  }, [])
                : [];
            return (
              <tr key={entry}>
                <td>{entry}</td>
                <td>{pairs.join(" · ")}</td>
                <RowActions
                  name={entry}
                  disabled={readOnly}
                  onRemove={() =>
                    void runtime.edit(db, detail.name, line("XDEL", detail.name, entry))
                  }
                />
              </tr>
            );
          })}
        </tbody>
      </table>
      <MoreRow runtime={runtime} db={db} page={page} />
      {dialog}
    </>
  );
}

export function KeyBody(props: ViewerProps) {
  switch (props.detail.type_name) {
    case "string":
      return <StringViewer {...props} />;
    case "hash":
      return <HashViewer {...props} />;
    case "list":
      return <ListViewer {...props} />;
    case "set":
      return <SetViewer {...props} />;
    case "zset":
      return <ZSetViewer {...props} />;
    case "stream":
      return <StreamViewer {...props} />;
    default:
      return (
        <div className={styles.empty}>
          Keys of type {props.detail.type_name} can't be shown here.
        </div>
      );
  }
}
