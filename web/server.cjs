const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.ECHO_WEB_PORT || 8124);
const STATIC_ROOT = __dirname;
const DEMO_ROOT = path.join(PROJECT_ROOT, "results", "demo");
const LIVE_ROOT = path.join(PROJECT_ROOT, "results", "demo-live");
const DEMO_AUDIO = path.join(PROJECT_ROOT, "data", "public", "alimeeting", "clips", "clip01.wav");
const LIVE_AUDIO = path.join(LIVE_ROOT, "audio.wav");
function resolvePython() {
  const candidates = [
    process.env.ECHO_PYTHON,
    // Windows venv layout
    path.join(PROJECT_ROOT, ".venv", "Scripts", "python.exe"),
    path.join(PROJECT_ROOT, "..", ".venv", "Scripts", "python.exe"),
    // macOS / Linux venv layout
    path.join(PROJECT_ROOT, ".venv", "bin", "python"),
    path.join(PROJECT_ROOT, "..", ".venv", "bin", "python"),
  ].filter(Boolean);
  const fallback = process.platform === "win32" ? "python" : "python3";
  return candidates.find((candidate) => candidate === process.env.ECHO_PYTHON || fs.existsSync(candidate)) || fallback;
}

const PYTHON = resolvePython();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wav": "audio/wav",
};

async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, "utf8"));
}

async function demoPayload(root = DEMO_ROOT, audioName = "clip01.wav", audioUrl = fs.existsSync(DEMO_AUDIO) ? "/media/demo.wav" : null) {
  const [asr, minutes] = await Promise.all([
    readJson(path.join(root, "transcript.json")),
    readJson(path.join(root, "minutes.json")),
  ]);
  return { asr, minutes, audioName, audioUrl };
}

function sendJson(res, status, value) {
  res.writeHead(status, { "Content-Type": MIME[".json"], "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const stream = fs.createReadStream(filePath);
  stream.on("error", () => {
    if (!res.headersSent) res.writeHead(404);
    res.end("Not found");
  });
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-store" });
  stream.pipe(res);
}

function readBody(req, maxBytes = 80 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("音频文件不能超过 80 MB"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function runDemo(audioPath) {
  await fsp.mkdir(LIVE_ROOT, { recursive: true });
  await fsp.copyFile(audioPath, LIVE_AUDIO);
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [path.join(PROJECT_ROOT, "scripts", "run_demo.py"), "--audio", audioPath, "--out", LIVE_ROOT], {
      cwd: PROJECT_ROOT,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", async (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `分析进程退出：${code}`));
        return;
      }
      try { resolve(await demoPayload(LIVE_ROOT, path.basename(audioPath), "/media/live.wav")); }
      catch (error) { reject(error); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/api/demo") {
      sendJson(res, 200, await demoPayload());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/analyze") {
      const body = await readBody(req);
      if (!body.length) { sendJson(res, 400, { error: "没有收到音频文件" }); return; }
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "echotrace-demo-"));
      const audioPath = path.join(tempDir, "upload.wav");
      await fsp.writeFile(audioPath, body);
      try { sendJson(res, 200, await runDemo(audioPath)); }
      finally { await fsp.rm(tempDir, { recursive: true, force: true }); }
      return;
    }
    if (req.method === "GET" && url.pathname === "/media/demo.wav") {
      sendFile(res, DEMO_AUDIO);
      return;
    }
    if (req.method === "GET" && url.pathname === "/media/live.wav") {
      sendFile(res, LIVE_AUDIO);
      return;
    }
    if (req.method === "GET" && url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "GET") {
      const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const filePath = path.resolve(STATIC_ROOT, relative);
      if (!filePath.startsWith(STATIC_ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404); res.end("Not found"); return;
      }
      sendFile(res, filePath);
      return;
    }
    res.writeHead(405); res.end("Method not allowed");
  } catch (error) {
    sendJson(res, 500, { error: error.message || "服务器错误" });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`EchoTrace web demo: http://127.0.0.1:${PORT}`);
});
