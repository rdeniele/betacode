import { runCli } from "./cli";

const code = await runCli(process.argv.slice(2), {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  env: process.env,
  cwd: process.cwd(),
  isTTY: !!process.stdin.isTTY && !!process.stdout.isTTY,
  color: !process.env.NO_COLOR && !!process.stdout.isTTY,
});
process.exit(code);
