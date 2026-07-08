import { spawn } from "node:child_process";

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    try {
      const proc = spawn(cmd, args, { windowsHide: true });
      const timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {}
        resolve("");
      }, 4000);
      timer.unref?.();
      proc.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
      proc.on("error", () => {
        clearTimeout(timer);
        resolve("");
      });
      proc.on("close", () => {
        clearTimeout(timer);
        resolve(out);
      });
    } catch {
      resolve("");
    }
  });
}

function write(cmd: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const proc = spawn(cmd, args, { windowsHide: true });
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const done = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };
      timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {}
        done(false);
      }, 4000);
      timer.unref?.();
      proc.on("error", () => done(false));
      const onFinish = (code: number | null = 0): void => done(code === 0);
      proc.on("exit", onFinish);
      proc.on("close", onFinish);
      proc.stdin?.end(text);
    } catch {
      resolve(false);
    }
  });
}

// Under WSL there's usually no X/Wayland, so wl-copy/xclip/xsel aren't
// installed and the native commands silently fail. Windows' clip.exe and
// powershell.exe are always reachable via WSL interop and target the Windows
// clipboard the user actually pastes into, so prefer them when running there.
const isWsl = process.platform === "linux" && !!process.env.WSL_DISTRO_NAME;

const LINUX_READ: [string, string[]][] = [
  ["wl-paste", ["--no-newline"]],
  ["xclip", ["-selection", "clipboard", "-o"]],
  ["xsel", ["-b"]],
];

const LINUX_WRITE: [string, string[]][] = [
  ["wl-copy", []],
  ["xclip", ["-selection", "clipboard"]],
  ["xsel", ["-b", "-i"]],
];

const WSL_READ: [string, string[]][] = [
  ["powershell.exe", ["-NoProfile", "-Command", "Get-Clipboard"]],
];

const WSL_WRITE: [string, string[]][] = [["clip.exe", []]];

export async function readClipboard(): Promise<string> {
  if (process.platform === "win32") {
    return (await run("powershell", ["-NoProfile", "-Command", "Get-Clipboard"])).trim();
  }
  if (process.platform === "darwin") {
    return (await run("pbpaste", [])).trim();
  }
  const readers = isWsl ? [...WSL_READ, ...LINUX_READ] : LINUX_READ;
  for (const [cmd, args] of readers) {
    const out = (await run(cmd, args)).trim();
    if (out) return out;
  }
  return "";
}

export async function writeClipboard(text: string): Promise<boolean> {
  if (process.platform === "win32") {
    return write(
      "powershell",
      ["-NoProfile", "-Command", "Set-Clipboard -Value ([Console]::In.ReadToEnd())"],
      text,
    );
  }
  if (process.platform === "darwin") {
    return write("pbcopy", [], text);
  }
  const writers = isWsl ? [...WSL_WRITE, ...LINUX_WRITE] : LINUX_WRITE;
  for (const [cmd, args] of writers) {
    if (await write(cmd, args, text)) return true;
  }
  return false;
}
