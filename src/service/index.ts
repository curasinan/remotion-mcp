// The service's runner: starts it, and on SIGTERM drains it and exits 0. It exports nothing; tests and later tasks
// import each module directly.
import { startService } from "./start.js";

startService(process.env).then((s) => {
  process.on("SIGTERM", () => {
    void s.shutdown().then(() => process.exit(0));
  });
}, (e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
