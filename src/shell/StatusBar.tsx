import { useStatusItems, sortedItems } from "./registry/statusItems";
import styles from "./StatusBar.module.css";

export function StatusBar() {
  const items = useStatusItems((s) => s.items);
  const render = (side: "left" | "right") =>
    sortedItems(items, side).map((i) => {
      const node = i.render();
      return node === null || node === undefined || node === false ? null : (
        <span key={i.id} className={styles.item} data-status-item={i.id}>
          {node}
        </span>
      );
    });
  return (
    <footer className={styles.bar} aria-label="Status bar">
      {render("left")}
      <span className={styles.spacer} />
      {render("right")}
    </footer>
  );
}
