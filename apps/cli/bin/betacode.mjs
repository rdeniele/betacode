#!/usr/bin/env node
// Launcher: registers the TypeScript loader, then runs the CLI from source.
import { register } from "tsx/esm/api";

register();
await import("../src/main.ts");
