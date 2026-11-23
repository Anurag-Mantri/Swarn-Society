import { app } from "./index.js";
import { config } from "./config.js";
import { pool } from "./db/index.js";

app.addHook("onClose", async () => {
  await pool.end();
});

const address = await app.listen({ port: config.port, host: "0.0.0.0" });
app.log.info({ address }, "Swarmroom server listening");
