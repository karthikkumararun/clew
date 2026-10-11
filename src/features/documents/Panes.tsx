import { useState } from "react";
import { useStore } from "zustand";
import { Button } from "../../components/Button";
import { Checkbox, Input } from "../../components/Input";
import { askChoice } from "../console/prompts";
import { DocViewSwitch, DocumentsResult } from "./DocResult";
import type { DocResultView } from "./DocResult";
import { toShell } from "./ejson";
import type { EJson } from "./ejson";
import { messageOf } from "./runtime";
import type { CollectionRuntime } from "./runtime";
import styles from "./Documents.module.css";

const sizeText = (n: number | null) =>
  n === null
    ? ""
    : n >= 1048576
      ? `${(n / 1048576).toFixed(1)} MB`
      : `${Math.max(1, Math.round(n / 1024))} KB`;

export function SchemaPane({ runtime }: { runtime: CollectionRuntime }) {
  const schema = useStore(runtime.store, (s) => s.schema);
  const loading = useStore(runtime.store, (s) => s.schemaLoading);
  const error = useStore(runtime.store, (s) => s.schemaError);
  return (
    <div className={styles.panel}>
      <div className={styles.formRow}>
        <span className={styles.stats}>
          {loading
            ? "Sampling…"
            : schema
              ? `Inferred from a sample of ${schema.sampled.toLocaleString()} ${schema.sampled === 1 ? "document" : "documents"}`
              : ""}
        </span>
        <Button variant="default" disabled={loading} onClick={() => void runtime.loadSchema()}>
          Resample
        </Button>
      </div>
      {error ? (
        <div role="alert" className={styles.errorText}>
          {error}
        </div>
      ) : null}
      {schema && schema.fields.length === 0 ? (
        <div className={styles.empty}>This collection has no documents to sample.</div>
      ) : null}
      {schema && schema.fields.length > 0 ? (
        <table className={styles.grid} aria-label="Inferred schema">
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Types</th>
              <th scope="col" style={{ width: 200 }}>
                Present in
              </th>
            </tr>
          </thead>
          <tbody>
            {schema.fields.map((f) => (
              <tr key={f.path}>
                <td className={styles.mono}>{f.path}</td>
                <td>{f.types.map((t) => `${t.type_name} ${t.percent}%`).join(" · ")}</td>
                <td>
                  <span
                    className={styles.bar}
                    style={{ width: Math.max(2, f.present_percent * 0.9) }}
                    aria-hidden="true"
                  />
                  {f.present_percent}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

export function IndexesPane({ runtime }: { runtime: CollectionRuntime }) {
  const indexes = useStore(runtime.store, (s) => s.indexes);
  const error = useStore(runtime.store, (s) => s.indexesError);
  const readOnly = useStore(runtime.store, (s) => s.readOnly);
  const [keys, setKeys] = useState("");
  const [name, setName] = useState("");
  const [unique, setUnique] = useState(false);
  const [sparse, setSparse] = useState(false);
  const [ttl, setTtl] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const drop = async (indexName: string) => {
    const choice = await askChoice({
      title: `Drop index ${indexName}?`,
      body: <p>Queries that relied on it may become much slower.</p>,
      choices: [
        { id: "cancel", label: "Cancel" },
        { id: "drop", label: "Drop index", variant: "primary" },
      ],
    });
    if (choice !== "drop") return;
    try {
      await runtime.dropIndex(indexName);
    } catch (e) {
      setFormError(messageOf(e));
    }
  };

  const create = async () => {
    setFormError(null);
    const seconds = ttl.trim() === "" ? null : Number(ttl);
    if (seconds !== null && (!Number.isInteger(seconds) || seconds < 0)) {
      return setFormError("The expiry is a whole number of seconds");
    }
    try {
      const ok = await runtime.createIndex({
        keys,
        name: name.trim() || null,
        unique,
        sparse,
        ttlSeconds: seconds,
      });
      if (ok) {
        setKeys("");
        setName("");
        setTtl("");
      }
    } catch (e) {
      setFormError(messageOf(e));
    }
  };

  return (
    <div className={styles.panel}>
      {error ? (
        <div role="alert" className={styles.errorText}>
          {error}
        </div>
      ) : null}
      {indexes ? (
        <table className={styles.grid} aria-label="Indexes">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Keys</th>
              <th scope="col">Options</th>
              <th scope="col">Size</th>
              <th scope="col" style={{ width: 80 }} />
            </tr>
          </thead>
          <tbody>
            {indexes.map((i) => (
              <tr key={i.name}>
                <td className={styles.mono}>{i.name}</td>
                <td className={styles.mono}>{toShell(i.keys as EJson, 0).replace(/\s+/g, " ")}</td>
                <td>
                  {[
                    i.unique ? "unique" : null,
                    i.sparse ? "sparse" : null,
                    i.ttl_seconds !== null ? `expires after ${i.ttl_seconds}s` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </td>
                <td>{sizeText(i.size_bytes)}</td>
                <td>
                  {i.name === "_id_" ? null : (
                    <Button
                      variant="ghost"
                      disabled={readOnly}
                      aria-label={`Drop index ${i.name}`}
                      onClick={() => void drop(i.name)}
                    >
                      Drop
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className={styles.empty}>Loading indexes…</div>
      )}
      <div className={styles.formRow}>
        <Input
          mono
          aria-label="Index keys"
          placeholder="{ field: 1 }"
          value={keys}
          onChange={(e) => setKeys(e.target.value)}
          style={{ width: 220 }}
        />
        <Input
          mono
          aria-label="Index name"
          placeholder="name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ width: 180 }}
        />
        <Checkbox label="Unique" checked={unique} onChange={(e) => setUnique(e.target.checked)} />
        <Checkbox label="Sparse" checked={sparse} onChange={(e) => setSparse(e.target.checked)} />
        <Input
          mono
          aria-label="Expire after seconds"
          placeholder="TTL seconds"
          value={ttl}
          onChange={(e) => setTtl(e.target.value)}
          style={{ width: 120 }}
        />
        <Button
          variant="primary"
          disabled={readOnly || keys.trim() === ""}
          onClick={() => void create()}
        >
          Create index
        </Button>
      </div>
      {formError ? (
        <div role="alert" className={styles.fieldError}>
          {formError}
        </div>
      ) : null}
    </div>
  );
}

/** The Aggregation view: a pipeline and its results as a tree or JSON. */
export function AggregationPane({
  runtime,
  pipeline,
  onPipeline,
  registerRun,
}: {
  runtime: CollectionRuntime;
  pipeline: string;
  onPipeline: (text: string) => void;
  /** Lets the Find shortcut run the pipeline while this view is up. */
  registerRun: (run: (() => void) | null) => void;
}) {
  const agg = useStore(runtime.store, (s) => s.agg);
  const [view, setView] = useState<Exclude<DocResultView, "table">>("tree");
  const run = () => void runtime.aggregate(pipeline);
  // `run` closes over the current text, so hand the shortcut a fresh one each render
  registerRun(run);
  return (
    <div className={styles.panel}>
      <textarea
        className={styles.textarea}
        aria-label="Pipeline"
        spellCheck={false}
        value={pipeline}
        onChange={(e) => onPipeline(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            run();
          }
        }}
      />
      <div className={styles.formRow}>
        <Button variant="primary" disabled={agg.loading} onClick={run}>
          Run pipeline
        </Button>
        <DocViewSwitch value={view} onChange={(v) => v !== "table" && setView(v)} omitTable />
        <span className={styles.stats} aria-live="polite">
          {agg.loading
            ? "Running…"
            : agg.elapsedMs !== null
              ? `${agg.docs.length.toLocaleString()}${agg.hasMore ? "+" : ""} ${agg.docs.length === 1 ? "document" : "documents"} · ${agg.elapsedMs} ms`
              : ""}
        </span>
      </div>
      {agg.error ? (
        <div role="alert" className={styles.fieldError}>
          {agg.error.message}
          {agg.error.position ? ` (at character ${agg.error.position})` : ""}
        </div>
      ) : null}
      {agg.elapsedMs !== null && agg.docs.length === 0 && !agg.loading && !agg.error ? (
        <div className={styles.empty}>The pipeline returned no documents.</div>
      ) : null}
      {agg.docs.length > 0 ? (
        <div>
          <DocumentsResult docs={agg.docs} view={view} version={agg.version} />
          {agg.hasMore ? (
            <div className={styles.more}>
              <Button
                variant="default"
                disabled={agg.fetching}
                onClick={() => void runtime.aggregateMore()}
              >
                {agg.fetching ? "Loading…" : "Load more"}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
