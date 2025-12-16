import "dotenv/config";
import { env } from "./lib/env";
import { makeServer } from "./server";

const app = makeServer();
app.listen(env.PORT, () => {
  console.log(`Mockera API listening on :${env.PORT}`);
});