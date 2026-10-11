import { useState } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { Input, Select } from "../../components/Input";
import { EDITABLE_TYPES, parseScalar } from "./ejson";
import type { EJson, TypeName } from "./ejson";
import { messageOf } from "./runtime";
import styles from "./Documents.module.css";

/** Edit one scalar, or add a field (a name and a value) to a document or object. */
export function ValueEditDialog({
  title,
  initialType,
  initialText,
  askName,
  takenNames = [],
  onSave,
  onClose,
}: {
  title: string;
  initialType: TypeName;
  initialText: string;
  /** Adding a field: also ask for its name. */
  askName?: boolean;
  takenNames?: string[];
  onSave: (name: string, value: EJson) => void;
  onClose: () => void;
}) {
  const startType = EDITABLE_TYPES.includes(initialType) ? initialType : "String";
  const [type, setType] = useState<TypeName>(startType);
  const [text, setText] = useState(initialText);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (askName) {
      if (!name.trim()) return setError("Give the field a name");
      if (takenNames.includes(name)) return setError(`There is already a field called ${name}`);
    }
    const parsed = parseScalar(type, text);
    if (!parsed.ok) return setError(parsed.error);
    onSave(name, parsed.value);
  };

  return (
    <Dialog
      title={title}
      maxWidth={460}
      onClose={onClose}
      footer={
        <>
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit}>
            {askName ? "Add field" : "Stage change"}
          </Button>
        </>
      }
    >
      <form
        className={styles.dialogBody}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {askName ? (
          <label className={styles.dialogBody}>
            Field name
            <Input
              dialog
              mono
              value={name}
              autoFocus
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
            />
          </label>
        ) : null}
        <div className={styles.dialogRow}>
          <label htmlFor="doc-edit-type">Type</label>
          <Select
            id="doc-edit-type"
            value={type}
            onChange={(e) => {
              setType(e.target.value as TypeName);
              setError(null);
            }}
          >
            {EDITABLE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </div>
        {type === "Null" ? null : (
          <label className={styles.dialogBody}>
            Value
            <Input
              dialog
              mono
              value={text}
              autoFocus={!askName}
              onChange={(e) => {
                setText(e.target.value);
                setError(null);
              }}
            />
          </label>
        )}
        {error ? (
          <div role="alert" className={styles.fieldError}>
            {error}
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}

/** Edit a whole document (or write a new one) as shell-syntax text. */
export function JsonEditDialog({
  title,
  initialText,
  saveLabel,
  onSave,
  onClose,
}: {
  title: string;
  initialText: string;
  saveLabel: string;
  /** Throw to keep the dialog open and show the message. */
  onSave: (text: string) => Promise<void>;
  onClose: () => void;
}) {
  const [text, setText] = useState(initialText);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await onSave(text);
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={title}
      maxWidth={640}
      onClose={onClose}
      footer={
        <>
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>
            {saveLabel}
          </Button>
        </>
      }
    >
      <div className={styles.dialogBody}>
        <textarea
          className={styles.textarea}
          aria-label="Document"
          spellCheck={false}
          value={text}
          autoFocus
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
        />
        {error ? (
          <div role="alert" className={styles.fieldError}>
            {error}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
