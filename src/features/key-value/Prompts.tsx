import { useState } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { Input } from "../../components/Input";
import styles from "./KeyValue.module.css";

export interface PromptField {
  id: string;
  label: string;
  initial?: string;
  multiline?: boolean;
  /** Reject empty input. */
  required?: boolean;
}

/** A small form: one or more text fields and a submit button. */
export function PromptDialog({
  title,
  fields,
  submitLabel,
  onSubmit,
  onClose,
}: {
  title: string;
  fields: PromptField[];
  submitLabel: string;
  /** Throw to keep the dialog open and show the message. */
  onSubmit: (values: Record<string, string>) => Promise<void> | void;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(fields.map((f) => [f.id, f.initial ?? ""])),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const missing = fields.find((f) => f.required && !values[f.id]?.trim());
    if (missing) return setError(`${missing.label} can't be empty`);
    setBusy(true);
    try {
      await onSubmit(values);
    } catch (e) {
      setError(typeof e === "object" && e && "message" in e ? String(e.message) : String(e));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={title}
      maxWidth={480}
      onClose={onClose}
      footer={
        <>
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form
        className={styles.dialogBody}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {fields.map((f, i) => (
          <label key={f.id}>
            {f.label}
            {f.multiline ? (
              <textarea
                className={styles.textarea}
                spellCheck={false}
                autoFocus={i === 0}
                value={values[f.id]}
                onChange={(e) => {
                  setValues({ ...values, [f.id]: e.target.value });
                  setError(null);
                }}
              />
            ) : (
              <Input
                dialog
                mono
                autoFocus={i === 0}
                value={values[f.id]}
                onChange={(e) => {
                  setValues({ ...values, [f.id]: e.target.value });
                  setError(null);
                }}
              />
            )}
          </label>
        ))}
        {error ? (
          <div role="alert" className={styles.fieldError}>
            {error}
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}
