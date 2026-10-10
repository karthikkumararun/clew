import { forwardRef, useId } from "react";
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import styles from "./Input.module.css";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  size?: never;
  dialog?: boolean;
  mono?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { dialog, mono, className, ...rest },
  ref,
) {
  const cls = [styles.input, dialog && styles.dialog, mono && styles.mono, className]
    .filter(Boolean)
    .join(" ");
  return <input ref={ref} className={cls} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, ...rest }, ref) {
    return (
      <select
        ref={ref}
        className={[styles.select, className].filter(Boolean).join(" ")}
        {...rest}
      />
    );
  },
);

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: ReactNode;
  description?: ReactNode;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, description, className, id, ...rest },
  ref,
) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <label htmlFor={inputId} className={[styles.check, className].filter(Boolean).join(" ")}>
      <input ref={ref} id={inputId} type="checkbox" {...rest} />
      <span>
        {label}
        {description ? <small>{description}</small> : null}
      </span>
    </label>
  );
});

export interface SegmentedControlProps<T extends string | number> {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
  "aria-label": string;
}

export function SegmentedControl<T extends string | number>({
  value,
  options,
  onChange,
  "aria-label": ariaLabel,
}: SegmentedControlProps<T>) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={styles.segmented}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={styles.segment}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
