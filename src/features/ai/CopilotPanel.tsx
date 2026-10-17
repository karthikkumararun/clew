import { useEffect, useState } from "react";
import { Button } from "../../components/Button";
import { Check } from "../../components/icons";
import { openExternal } from "./external";
import {
  copilotAcceptConsent,
  copilotBegin,
  copilotCancel,
  copilotCheckNow,
  copilotDeclineConsent,
  copilotSignOut,
  useCopilot,
} from "./copilotStore";
import styles from "./AiSettings.module.css";

/** `14:32` from a number of milliseconds. */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const mb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024 / 1024))} MB`;

function Remaining({ until }: { until: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <>{countdown(until - now)}</>;
}

/** The sign-in states of GitHub Copilot (design/canvas/AIProviders.dc.html). */
export function CopilotPanel() {
  const c = useCopilot();
  const failed = (c.phase === "expired" || c.phase === "no_access" || c.phase === "error") && (
    <p className={styles.bad} role="alert">
      {c.phase === "expired"
        ? "The code expired — try again"
        : c.phase === "no_access"
          ? "This GitHub account doesn't have Copilot access"
          : c.error}
    </p>
  );

  if (c.phase === "in") {
    return (
      <div className={styles.signedIn}>
        <Check size={16} />
        <span className={styles.grow}>
          Signed in as <span className={styles.monoText}>@{c.login}</span> · Copilot plan detected
        </span>
        <Button variant="ghost" onClick={() => void copilotSignOut()}>
          Sign out
        </Button>
      </div>
    );
  }

  if (c.phase === "pending" && c.userCode) {
    const url = c.verificationUri ?? "https://github.com/login/device";
    return (
      <div className={styles.pending}>
        <div className={styles.pendingHint}>
          Enter this code at{" "}
          <button type="button" className={styles.link} onClick={() => void openExternal(url)}>
            github.com/login/device
          </button>
        </div>
        <div className={styles.codeRow}>
          <span className={styles.code} data-testid="copilot-code">
            {c.userCode}
          </span>
          <Button
            variant="default"
            onClick={() => {
              void navigator.clipboard.writeText(c.userCode ?? "").catch(() => {});
              void openExternal(url);
            }}
          >
            Copy &amp; open browser
          </Button>
        </div>
        <div className={styles.waiting}>
          Waiting for authorization…{" "}
          {c.expiresAt ? (
            <>
              expires in <Remaining until={c.expiresAt} />
            </>
          ) : null}
          <Button variant="toolbar" onClick={() => void copilotCheckNow()}>
            Check now
          </Button>
          <Button variant="ghost" onClick={() => void copilotCancel()}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  if (c.phase === "consent") {
    return (
      <div className={styles.consent} role="group" aria-label="Download the Copilot component">
        <p className={styles.consentText}>
          Clew needs GitHub&apos;s Copilot component to talk to Copilot. It is a separate program
          from GitHub
          {c.downloadBytes ? ` (about ${mb(c.downloadBytes)})` : ""}, downloaded from the npm
          registry only if you agree, checked against its checksum, and stored in Clew&apos;s data
          folder.
        </p>
        <div className={styles.consentActions}>
          <Button variant="primary" onClick={() => void copilotAcceptConsent()}>
            Download and continue
          </Button>
          <Button variant="ghost" onClick={() => void copilotDeclineConsent()}>
            Not now
          </Button>
        </div>
      </div>
    );
  }

  if (c.phase === "downloading" || c.phase === "starting") {
    return (
      <div className={styles.waiting} role="status">
        {c.phase === "downloading"
          ? `Downloading the Copilot component… ${c.percent}%`
          : "Starting the Copilot component…"}
        {c.phase === "downloading" ? (
          <Button variant="ghost" onClick={() => void copilotDeclineConsent()}>
            Cancel
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className={styles.signedOut}>
      <p className={styles.plain}>
        Sign in with the GitHub account that has Copilot. Clew opens github.com in your browser and
        never sees your password.
      </p>
      {failed}
      <Button variant="primary" onClick={() => void copilotBegin()}>
        Sign in with GitHub
      </Button>
    </div>
  );
}
