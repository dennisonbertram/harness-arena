import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const marker = process.env.LOCK_TEST_AFTER_ORDER_MARKER;
const gate = process.env.LOCK_TEST_AFTER_ORDER_GATE;
if (marker && gate) {
  const originalRename = fs.promises.rename.bind(fs.promises);
  let delayed = false;
  fs.promises.rename = async (source, target) => {
    if (!delayed && String(target).endsWith(".claim")) {
      delayed = true;
      await fs.promises.writeFile(marker, "order-allocated");
      while (true) {
        try { await fs.promises.access(gate); break; } catch { await new Promise((resolve) => setTimeout(resolve, 2)); }
      }
    }
    return originalRename(source, target);
  };
  syncBuiltinESMExports();
}
