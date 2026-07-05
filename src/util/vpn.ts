import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { networkInterfaces } from "node:os";

const run = promisify(execFile);

export function parseDefaultInterface(platform: NodeJS.Platform, output: string): string | null {
  if (platform === "linux") return output.match(/\bdev\s+(\S+)/)?.[1] ?? null;
  if (platform === "darwin") return output.match(/^\s*interface:\s*(\S+)/m)?.[1] ?? null;
  if (platform === "win32") return output.trim().split(/\r?\n/).find(Boolean)?.trim() ?? null;
  return null;
}

export async function defaultRouteInterface(platform: NodeJS.Platform = process.platform): Promise<string | null> {
  try {
    if (platform === "linux") return parseDefaultInterface(platform, (await run("ip", ["route", "show", "default"])).stdout);
    if (platform === "darwin") return parseDefaultInterface(platform, (await run("route", ["-n", "get", "default"])).stdout);
    if (platform === "win32") return parseDefaultInterface(platform, (await run("powershell.exe", [
      "-NoProfile", "-Command", "(Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1).InterfaceAlias",
    ])).stdout);
  } catch {}
  return null;
}

export async function vpnRouteIsSafe(name: string): Promise<boolean> {
  const wanted = name.trim();
  if (!wanted) return true;
  const addresses = networkInterfaces()[wanted];
  if (!addresses?.some((address) => !address.internal)) return false;
  return (await defaultRouteInterface()) === wanted;
}
