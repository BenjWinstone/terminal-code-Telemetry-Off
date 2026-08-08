#!/usr/bin/env node
import { createInjector } from "./inject";

const upstream = Number(process.argv[2]);
const port = Number(process.argv[3]);
const cssFile = process.argv[4];
const fontFile = process.argv[5];

if (!upstream || !port || !cssFile) {
  process.stderr.write("usage: injector-main <upstreamPort> <port> <cssFile>\n");
  process.exit(1);
}

createInjector(upstream, cssFile, fontFile).listen(port, "127.0.0.1", () => {
  process.stdout.write(`tode injector ${port} -> ${upstream}\n`);
});
