import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CACHE_DIR } from "../runtime/paths";


interface Product {
  nameShort?: string;
  nameLong?: string;
  applicationName?: string;
}

function readProduct(appDir: string): Product | null {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(appDir, "Contents", "Resources", "app", "product.json"), "utf8"),
    ) as Product;
  } catch {
    return null;
  }
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function appDirs(): string[] {
  const roots = ["/Applications", path.join(os.homedir(), "Applications")];
  return roots.flatMap((root) => {
    try {
      return fs
        .readdirSync(root)
        .filter((entry) => entry.endsWith(".app"))
        .map((entry) => path.join(root, entry));
    } catch {
      return [];
    }
  });
}

function macBundleFor(editorName: string): string | null {
  const wanted = slug(editorName);
  for (const dir of appDirs()) {
    const product = readProduct(dir);
    if (!product) continue;
    const names = [product.nameShort, product.nameLong, product.applicationName].filter(
      Boolean,
    ) as string[];
    if (names.some((name) => slug(name) === wanted)) return dir;
  }
  return null;
}

function macIcns(appDir: string): string | null {
  const resources = path.join(appDir, "Contents", "Resources");
  try {
    const plist = fs.readFileSync(path.join(appDir, "Contents", "Info.plist"), "utf8");
    const declared = /<key>CFBundleIconFile<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
    if (declared) {
      const file = declared.endsWith(".icns") ? declared : `${declared}.icns`;
      const full = path.join(resources, file);
      if (fs.existsSync(full)) return full;
    }
  } catch {}
  try {
    const found = fs.readdirSync(resources).find((entry) => entry.endsWith(".icns"));
    return found ? path.join(resources, found) : null;
  } catch {
    return null;
  }
}

function linuxIconFor(editorName: string): string | null {
  const wanted = slug(editorName);
  const dataDirs = [
    path.join(os.homedir(), ".local", "share", "applications"),
    "/usr/share/applications",
    "/var/lib/flatpak/exports/share/applications",
  ];
  for (const dir of dataDirs) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir).filter((entry) => entry.endsWith(".desktop"));
    } catch {
      continue;
    }
    for (const entry of entries) {
      let body = "";
      try {
        body = fs.readFileSync(path.join(dir, entry), "utf8");
      } catch {
        continue;
      }
      const name = /^Name=(.+)$/m.exec(body)?.[1];
      const icon = /^Icon=(.+)$/m.exec(body)?.[1];
      if (!name || !icon || slug(name) !== wanted) continue;
      if (icon.startsWith("/") && fs.existsSync(icon)) return icon;
      for (const size of ["64x64", "48x48", "128x128", "32x32"]) {
        const candidate = `/usr/share/icons/hicolor/${size}/apps/${icon}.png`;
        if (fs.existsSync(candidate)) return candidate;
      }
      const pixmap = `/usr/share/pixmaps/${icon}.png`;
      if (fs.existsSync(pixmap)) return pixmap;
    }
  }
  return null;
}

export function editorIconPng(editorName: string): string | null {
  if (process.platform === "linux") return linuxIconFor(editorName);
  if (process.platform !== "darwin") return null;
  const bundle = macBundleFor(editorName);
  if (!bundle) return null;
  const icns = macIcns(bundle);
  if (!icns) return null;
  let stamp = 0;
  try {
    stamp = Math.floor(fs.statSync(icns).mtimeMs);
  } catch {}
  const cached = path.join(CACHE_DIR, "app-icons", `${slug(editorName)}-${stamp}.png`);
  if (fs.existsSync(cached)) return cached;
  try {
    
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    execFileSync(
      "sips",
      ["-z", "64", "64", "-s", "format", "png", icns, "--out", cached],
      { stdio: "ignore" },
    );
    return fs.existsSync(cached) ? cached : null;
  } catch {
    return null;
  }
}
