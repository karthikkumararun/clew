export const MIN_PASSPHRASE = 12;

export interface Strength {
  /** 0 = too short, 1–4 = weak … strong. */
  score: 0 | 1 | 2 | 3 | 4;
  label: "Too short" | "Weak" | "Okay" | "Good" | "Strong";
}

const LABELS: Strength["label"][] = ["Too short", "Weak", "Okay", "Good", "Strong"];

/** A rough length-and-variety meter. The minimum length is the only hard rule. */
export function passphraseStrength(p: string): Strength {
  const length = [...p].length;
  if (length < MIN_PASSPHRASE) return { score: 0, label: LABELS[0] };
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length;
  let score = 1;
  if (length >= 16) score++;
  if (classes >= 3 || /\s/.test(p)) score++;
  if (length >= 20) score++;
  const capped = Math.min(score, 4) as Strength["score"];
  return { score: capped, label: LABELS[capped] };
}

/** Why Export is disabled, or `null` when the passphrase is acceptable. */
export function passphraseProblem(passphrase: string, confirm: string): string | null {
  if ([...passphrase].length < MIN_PASSPHRASE) {
    return `Use at least ${MIN_PASSPHRASE} characters`;
  }
  if (passphrase !== confirm) return "The passphrases don't match";
  return null;
}
