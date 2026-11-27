const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

function runProcess(command, args, options, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      windowsHide: true,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const output = [];
    let errorOutput = "";
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => { errorOutput = (errorOutput + chunk).slice(-12000); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(output));
      else reject(new Error(errorOutput.trim() || "处理进程退出，退出码 " + code));
    });
    if (input !== undefined) {
      child.stdin.on("error", (error) => {
        if (error.code !== "EPIPE") reject(error);
      });
      child.stdin.end(input);
    }
  });
}

function isReadyWav(bytes) {
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" ||
      bytes.toString("ascii", 8, 12) !== "WAVE") return false;
  let pcm = false;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const name = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > bytes.length) return false;
    if (name === "fmt " && size >= 16) {
      pcm = bytes.readUInt16LE(start) === 1 && bytes.readUInt16LE(start + 2) === 1 &&
        bytes.readUInt32LE(start + 4) === 16000 && bytes.readUInt16LE(start + 14) === 16;
    }
    if (name === "data") return pcm && size > 0;
    offset = start + size + (size % 2);
  }
  return false;
}

async function prepareAudio(bytes, extension, directory, converter) {
  const wav = path.join(directory, "audio.wav");
  if (extension === ".wav" && isReadyWav(bytes)) {
    await fs.writeFile(wav, bytes);
    return wav;
  }
  const source = path.join(directory, "source" + extension);
  await fs.writeFile(source, bytes);
  try {
    await runProcess(converter, [
      "-nostdin", "-hide_banner", "-loglevel", "error",
      "-i", source, "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav,
    ]);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw Object.assign(new Error("找不到 FFmpeg。请按运行说明安装，或先导入 16 kHz 单声道 PCM WAV。"), { status: 503 });
    }
    throw Object.assign(new Error("无法读取这段录音。请确认文件可以播放，且格式为 WAV、M4A 或 MP3。"), { status: 422 });
  } finally {
    await fs.rm(source, { force: true });
  }
  return wav;
}

module.exports = { prepareAudio, runProcess };
