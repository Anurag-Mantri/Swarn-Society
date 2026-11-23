import { app, expireStaleHosts, flushHostStatusUpdates } from "./index.js";
import { config } from "./config.js";
import { pool } from "./db/index.js";

const livenessTimer = setInterval(() => {
  void expireStaleHosts().catch((error: unknown) => {
    app.log.error({ error }, "Could not expire stale hosts");
  });
}, config.hostHeartbeatSweepMs);
livenessTimer.unref();

app.addHook("onClose", async () => {
  clearInterval(livenessTimer);
  await flushHostStatusUpdates();
  await pool.end();
});

const address = await app.listen({ port: config.port, host: "0.0.0.0" });
app.log.info({ address }, "Swarmroom server listening");
