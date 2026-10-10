import { useEffect } from "react";
import { IconButton } from "../components/Button";
import { Close, Warning } from "../components/icons";
import { useNotices } from "../stores/noticesStore";
import styles from "./Notices.module.css";

const AUTO_DISMISS_MS = 12_000;

function NoticeItem({ id, message }: { id: number; message: string }) {
  const dismiss = useNotices((s) => s.dismiss);
  useEffect(() => {
    const t = setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [id, dismiss]);
  return (
    <div className={styles.notice} role="status">
      <span className={styles.icon}>
        <Warning size={14} />
      </span>
      <span className={styles.text}>{message}</span>
      <IconButton
        aria-label="Dismiss notice"
        onClick={() => dismiss(id)}
        style={{ width: 20, height: 20 }}
      >
        <Close size={10} />
      </IconButton>
    </div>
  );
}

export function Notices() {
  const notices = useNotices((s) => s.notices);
  if (notices.length === 0) return null;
  return (
    <div className={styles.stack}>
      {notices.map((n) => (
        <NoticeItem key={n.id} id={n.id} message={n.message} />
      ))}
    </div>
  );
}
