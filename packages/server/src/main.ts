import { App } from "./app";
import { startHttpServer } from "./http";

const port = Number(process.env.BETACODE_PORT ?? 4317);

const app = await App.create();
const initial = process.env.BETACODE_PROJECT ?? process.argv[2];
if (initial) {
  try {
    await app.openProject(initial);
  } catch (e) {
    console.error(`Could not open project ${initial}: ${(e as Error).message}`);
  }
}
const srv = await startHttpServer(app, { port });
console.log(`BetaCode runtime listening on ${srv.url}`);

const stop = async () => {
  await srv.close();
  await app.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
