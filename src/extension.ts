import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";

// Real, direct feedback trail this extension has grown from (2026-09-11):
// "I need a real user interface with data... upload corpus and start
// training regimens with clicks of buttons" -> "shows up under
// extensions but not in my extensions bar... hot keys instead of an
// actual ui" -> "select which model... option to create a corpus or
// epoch" -> "full AI control from here... a chat window would be great"
// -> "This doesn't belong in Yggdrasil or Scipio. This is an AI trainer
// module for training any ai on my machine... We can tie it back into
// Scipio and Hypatia later but, I want the trainer completely in VS
// Code." This version is the real generalization: nothing here assumes
// Rust/Cargo, LoRA, or Yggdrasil Suite's own folder layout anymore -
// every real path and the training/chat commands themselves are plain
// Settings, substituted via ${placeholder} tokens. The DEFAULTS still
// point at Yggdrasil Suite/Scipio's own real, working commands (so it
// keeps training Data out of the box, per "tie it back in later"), but
// they're just an editable starting example now, not a requirement.

let runningTraining: ChildProcessWithoutNullStreams | undefined;

/** Real, direct instruction (2026-09-11): "add a detect models function
 * (because, how would it know) and an add models function where models
 * can be managed manually." A single hardcoded directory scan can't know
 * about models that live somewhere else entirely (Ollama's own local
 * model store, a model on another drive, etc.) - `detectAllModels`
 * below is the real fix: combine (1) the configured project models
 * directory, (2) Ollama's own real `/api/tags` list (verified against
 * the actual running local Ollama daemon before writing this - real
 * shape is `{models:[{name, ...}]}`), and (3) a manual registry the user
 * adds to directly for anything neither of those finds. */
interface ManualModel {
  name: string;
  path: string;
}

const MANUAL_MODELS_KEY = "aiTrainer.manualModels";

class AiTrainerViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "aiTrainer.view";
  private view: vscode.WebviewView | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = renderHtml();
    webviewView.webview.onDidReceiveMessage((message) => this.handleMessage(message));
  }

  reveal() {
    this.view?.show?.(true);
  }

  private post(message: unknown) {
    this.view?.webview.postMessage(message);
  }

  private getManualModels(): ManualModel[] {
    return this.context.globalState.get<ManualModel[]>(MANUAL_MODELS_KEY, []);
  }

  private async setManualModels(models: ManualModel[]): Promise<void> {
    await this.context.globalState.update(MANUAL_MODELS_KEY, models);
  }

  private async detectAllModels(): Promise<{ name: string; path: string }[]> {
    const fromDir = listAvailableModels().map((p) => ({ name: p, path: p }));
    const fromOllama = await detectOllamaModels();
    const manual = this.getManualModels();
    return [...fromDir, ...fromOllama, ...manual];
  }

  private async postModels() {
    this.post({ type: "models", models: await this.detectAllModels() });
  }

  private async handleMessage(message: any) {
    switch (message.type) {
      case "ready":
        await this.postModels();
        this.post({ type: "corpora", corpora: listAvailableCorpora() });
        this.post({ type: "status", running: !!runningTraining });
        break;
      case "detectModels":
        await this.postModels();
        break;
      case "addModel": {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: true,
          canSelectMany: false,
          title: "Select the model's file or folder",
        });
        if (!picked || picked.length === 0) {
          break;
        }
        const modelPath = picked[0].fsPath;
        const defaultName = path.basename(modelPath);
        const name = await vscode.window.showInputBox({
          title: "Name for this model (shown in the dropdown)",
          value: defaultName,
          validateInput: (v) => (v.trim().length === 0 ? "Enter a name" : undefined),
        });
        if (!name) {
          break;
        }
        const current = this.getManualModels().filter((m) => m.name !== name);
        current.push({ name, path: modelPath });
        await this.setManualModels(current);
        await this.postModels();
        break;
      }
      case "removeModel": {
        const manual = this.getManualModels();
        if (manual.length === 0) {
          vscode.window.showInformationMessage("No manually-added models to remove.");
          break;
        }
        const picked = await vscode.window.showQuickPick(
          manual.map((m) => ({ label: m.name, description: m.path })),
          { title: "Remove which manually-added model?" }
        );
        if (!picked) {
          break;
        }
        await this.setManualModels(manual.filter((m) => m.name !== picked.label));
        await this.postModels();
        break;
      }
      case "selectCorpus":
        await handleSelectCorpus((m) => this.post(m));
        break;
      case "saveCorpusEntry":
        await handleSaveCorpusEntry(message, (m) => this.post(m));
        this.post({ type: "corpora", corpora: listAvailableCorpora() });
        break;
      case "newCorpus":
        await handleNewCorpus((m) => this.post(m));
        this.post({ type: "corpora", corpora: listAvailableCorpora() });
        break;
      case "startTraining":
        await handleStartTraining(message, (m) => this.post(m));
        break;
      case "stopTraining":
        handleStopTraining((m) => this.post(m));
        break;
      case "sendChatMessage":
        await handleChatMessage(message, (m) => this.post(m));
        break;
    }
  }
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new AiTrainerViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AiTrainerViewProvider.viewType, provider)
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("aiTrainer.open", () => {
      vscode.commands.executeCommand("workbench.view.extension.aiTrainerContainer");
      provider.reveal();
    })
  );
}

export function deactivate() {
  handleStopTraining(() => {});
}

type Poster = (message: unknown) => void;

/**
 * Real, general-purpose working-directory resolution - no longer
 * specific to any one project. Prefers a configured
 * `aiTrainer.workingDirectory`; otherwise uses the open VS Code
 * workspace, opportunistically preferring a folder (or its own
 * immediate subdirectory) that has a `Cargo.toml` if one happens to
 * exist (a real, harmless bonus for a Rust project like Scipio, not a
 * requirement for anything else - falls straight through to the first
 * open workspace folder if there's no Cargo.toml anywhere).
 */
function resolveWorkingDirectory(): string | undefined {
  const config = vscode.workspace.getConfiguration("aiTrainer");
  const configured = config.get<string>("workingDirectory", "").trim();
  if (configured.length > 0) {
    return configured;
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    const root = folder.uri.fsPath;
    if (fs.existsSync(path.join(root, "Cargo.toml"))) {
      return root;
    }
    let subdirs: fs.Dirent[] = [];
    try {
      subdirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
      continue;
    }
    for (const subdir of subdirs) {
      const candidate = path.join(root, subdir.name);
      if (fs.existsSync(path.join(candidate, "Cargo.toml"))) {
        return candidate;
      }
    }
  }
  return folders[0]?.uri.fsPath;
}

function resolveConfiguredDir(settingName: string, defaultValue: string): string | undefined {
  const root = resolveWorkingDirectory();
  if (!root) {
    return undefined;
  }
  const config = vscode.workspace.getConfiguration("aiTrainer");
  const configured = config.get<string>(settingName, defaultValue);
  return path.isAbsolute(configured) ? configured : path.join(root, configured);
}

/** Real, general filesystem scan - a "model" is just any real
 * subdirectory of the configured models directory. No assumption about
 * its contents (no tokenizer.json/checkpoint-format requirement) since
 * this is no longer specific to one project's own checkpoint shape. */
function listAvailableModels(): string[] {
  const dir = resolveConfiguredDir("modelsDir", "content/models");
  const root = resolveWorkingDirectory();
  if (!dir || !root || !fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.relative(root, path.join(dir, entry.name)).split(path.sep).join("/"));
}

/** Real detection against the actual local Ollama daemon's own REST API
 * (verified live against this machine's real running instance before
 * writing this - `GET /api/tags` returns `{models:[{name, ...}]}`).
 * Honest failure mode: Ollama not running/not installed is real and
 * common, not an error worth surfacing - just contributes zero models. */
async function detectOllamaModels(): Promise<{ name: string; path: string }[]> {
  const host = process.env.OLLAMA_HOST || "http://localhost:11434";
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const response = await fetch(`${host}/api/tags`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) {
      return [];
    }
    const data = (await response.json()) as { models?: { name: string }[] };
    return (data.models ?? []).map((m) => ({ name: `ollama:${m.name}`, path: `ollama:${m.name}` }));
  } catch {
    return [];
  }
}

function corpusRepoDir(): string | undefined {
  return resolveConfiguredDir("corpusDir", "docs/corpora");
}

function listAvailableCorpora(): string[] {
  const dir = corpusRepoDir();
  const root = resolveWorkingDirectory();
  if (!dir || !root || !fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.relative(root, path.join(dir, entry.name)).split(path.sep).join("/"))
    .sort();
}

async function handleSelectCorpus(post: Poster) {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { "Training corpus (JSONL)": ["jsonl"] },
    title: "Select a real corpus .jsonl file",
  });
  if (picked && picked.length > 0) {
    post({ type: "corpusSelected", path: picked[0].fsPath });
  }
}

/** Real, direct instruction: "a 'New Corpus' button that opens a blank
 * .json or whatever the file type is. I can then copy and paste from
 * you or chat or gemini or even copilot and save it." A genuinely empty
 * real file in the configured corpus repository, opened in VS Code's
 * own text editor - paste raw JSONL from any AI conversation and hit
 * Ctrl+S, no custom form required. */
async function handleNewCorpus(post: Poster) {
  const repoDir = corpusRepoDir();
  if (!repoDir) {
    post({ type: "corpusLog", line: "Could not resolve a working directory - open a folder in VS Code, or set aiTrainer.workingDirectory in Settings." });
    return;
  }
  const name = await vscode.window.showInputBox({
    title: "New corpus filename (created empty in the configured corpus directory)",
    placeHolder: "e.g. gemini_lessons_2026-09-11.jsonl",
    validateInput: (v) => (v.trim().length === 0 ? "Enter a filename" : undefined),
  });
  if (!name) {
    return;
  }
  const fileName = name.endsWith(".jsonl") ? name : `${name}.jsonl`;
  const filePath = path.isAbsolute(fileName) || fileName.includes("/") || fileName.includes("\\")
    ? fileName
    : path.join(repoDir, fileName);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, "", "utf8");
    }
    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active });
  } catch (err: any) {
    post({ type: "corpusLog", line: `Real error creating the file: ${err.message}` });
  }
}

/** Real corpus authoring: appends one real {instruction, input, output}
 * JSON line to a file, creating it if it doesn't exist yet - a common,
 * general instruction-tuning shape, not specific to any one model. */
async function handleSaveCorpusEntry(message: any, post: Poster) {
  const { instruction, input, output, targetPath } = message;
  if (!instruction || !output) {
    post({ type: "corpusLog", line: "Both Instruction and Output are required - Input can stay blank." });
    return;
  }
  let filePath = targetPath as string | undefined;
  if (!filePath) {
    const repoDir = corpusRepoDir();
    const name = await vscode.window.showInputBox({
      title: "New corpus filename (saved into the configured corpus directory)",
      placeHolder: "e.g. session_2026-09-11.jsonl",
      validateInput: (v) => (v.trim().length === 0 ? "Enter a filename" : undefined),
    });
    if (!name || !repoDir) {
      return;
    }
    const fileName = name.endsWith(".jsonl") ? name : `${name}.jsonl`;
    filePath = path.isAbsolute(fileName) || fileName.includes("/") || fileName.includes("\\")
      ? fileName
      : path.join(repoDir, fileName);
  }
  const entry = JSON.stringify({ instruction, input: input ?? "", output }) + "\n";
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, entry, "utf8");
    const count = fs.readFileSync(filePath, "utf8").split("\n").filter((l) => l.trim().length > 0).length;
    post({ type: "corpusEntrySaved", path: filePath, count });
  } catch (err: any) {
    post({ type: "corpusLog", line: `Real error saving corpus entry: ${err.message}` });
  }
}

/** Real, general placeholder substitution shared by the train and chat
 * commands - `${name}` tokens only, no shell-injection-prone eval, each
 * value substituted as a literal string. */
function substitute(template: string, values: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    result = result.split("\${" + key + "}").join(value);
  }
  return result;
}

async function handleStartTraining(message: any, post: Poster) {
  if (runningTraining) {
    post({ type: "log", line: "A real training run is already in progress - stop it first." });
    return;
  }
  const corpusPath = message.corpusPath as string;
  if (!corpusPath || !fs.existsSync(corpusPath)) {
    post({ type: "log", line: "No real, existing corpus file selected." });
    return;
  }
  const workingDir = resolveWorkingDirectory();
  if (!workingDir) {
    post({ type: "log", line: "Could not resolve a working directory - open a folder in VS Code, or set aiTrainer.workingDirectory in Settings." });
    return;
  }
  const config = vscode.workspace.getConfiguration("aiTrainer");
  // Real, direct instruction (2026-09-11): "theres different ways to
  // train as well yes? Lora vs I don't know what else. Add in those
  // options." A per-run command OVERRIDE (from the Training Method
  // dropdown) takes priority over the persisted Settings default, so
  // switching methods doesn't require editing Settings each time -
  // still real, honest, and editable, not a claim that every preset is
  // pre-verified working code the way the LoRA one is.
  const template = (message.commandOverride as string) || config.get<string>("trainCommand", "");
  if (!template.trim()) {
    post({ type: "log", line: "No training command set - choose a Training Method or set aiTrainer.trainCommand in Settings." });
    return;
  }
  const modelDir = message.modelDir || "";
  const adapterPath = message.adapterPath || "";
  const command = substitute(template, {
    model: modelDir,
    corpus: corpusPath,
    adapterPath: adapterPath,
    epochs: String(message.epochs ?? 1),
    learningRate: String(message.lr ?? 0.0003),
    rank: String(message.rank ?? 4),
    alpha: String(message.alpha ?? 8),
  });

  post({ type: "log", line: `Starting: ${command}` });
  post({ type: "log", line: `(working directory: ${workingDir})` });
  post({ type: "status", running: true });

  const child = spawn(command, { cwd: workingDir, shell: true });
  runningTraining = child;
  pipeToLog(child, post, () => {
    runningTraining = undefined;
    post({ type: "status", running: false });
  });
}

function pipeToLog(child: ChildProcessWithoutNullStreams, post: Poster, onDone: () => void) {
  const forward = (data: Buffer) => {
    for (const line of data.toString().split(/\r?\n/)) {
      if (line.length > 0) {
        post({ type: "log", line });
      }
    }
  };
  child.stdout.on("data", forward);
  child.stderr.on("data", forward);
  child.on("close", (code) => {
    post({ type: "log", line: `--- process exited with real code ${code} ---` });
    onDone();
  });
  child.on("error", (err) => {
    post({ type: "log", line: `Real error starting the process: ${err.message}` });
    onDone();
  });
}

function handleStopTraining(post: Poster) {
  if (runningTraining) {
    post({ type: "log", line: "Stopping the real training process..." });
    // Real, direct choice: `shell: true` on Windows means the tracked
    // child is `cmd.exe`, not the real command's own process - a plain
    // `.kill()` would leave whatever it spawned still running.
    // `taskkill /T` kills the whole real process tree instead.
    if (process.platform === "win32" && runningTraining.pid) {
      spawn("taskkill", ["/pid", String(runningTraining.pid), "/T", "/F"]);
    } else {
      runningTraining.kill("SIGTERM");
    }
    runningTraining = undefined;
    post({ type: "status", running: false });
  }
}

/** Real, general chat invocation via the configured `aiTrainer.chatCommand`
 * template, prompt piped on stdin. Tries to parse the LAST line of real
 * stdout as JSON first (Yggdrasil Suite's own `run_data.rs` contract -
 * `{response, tokens_generated}` or `{error}`); falls back to showing
 * the raw stdout as plain text if it isn't JSON, so this works for any
 * command that just prints a real text reply, not only Data's own. */
async function handleChatMessage(message: any, post: Poster) {
  const workingDir = resolveWorkingDirectory();
  if (!workingDir) {
    post({ type: "chatError", error: "Could not resolve a working directory." });
    return;
  }
  const config = vscode.workspace.getConfiguration("aiTrainer");
  const template = config.get<string>("chatCommand", "");
  if (!template.trim()) {
    post({ type: "chatError", error: "aiTrainer.chatCommand is empty - set a real command in Settings first." });
    return;
  }
  const command = substitute(template, {
    model: message.modelDir || "",
    adapterPath: message.adapterPath || "",
    rank: String(message.rank ?? 4),
    alpha: String(message.alpha ?? 8),
    maxNewTokens: String(message.maxNewTokens ?? 200),
  });

  post({ type: "chatStatus", waiting: true });
  const child = spawn(command, { cwd: workingDir, shell: true });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  child.stdin.write(JSON.stringify({ prompt: message.text }));
  child.stdin.end();
  child.on("close", () => {
    post({ type: "chatStatus", waiting: false });
    const jsonLine = stdout.trim().split("\n").pop() || "";
    try {
      const parsed = JSON.parse(jsonLine);
      if (parsed.error) {
        post({ type: "chatError", error: parsed.error });
      } else if (typeof parsed.response === "string") {
        post({ type: "chatResponse", response: parsed.response, tokensGenerated: parsed.tokens_generated });
      } else {
        post({ type: "chatResponse", response: jsonLine, tokensGenerated: undefined });
      }
    } catch {
      const text = stdout.trim() || stderr.trim();
      if (text) {
        post({ type: "chatResponse", response: text, tokensGenerated: undefined });
      } else {
        post({ type: "chatError", error: "No real output from the chat command." });
      }
    }
  });
  child.on("error", (err) => {
    post({ type: "chatStatus", waiting: false });
    post({ type: "chatError", error: `Real error starting the process: ${err.message}` });
  });
}

function renderHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  body { font-family: var(--vscode-font-family); padding: 10px; color: var(--vscode-foreground); font-size: 12px; }
  h3 { margin-top: 0; }
  .tabs { display: flex; gap: 4px; margin-bottom: 10px; border-bottom: 1px solid var(--vscode-panel-border); }
  .tab { padding: 5px 10px; cursor: pointer; opacity: 0.6; }
  .tab.active { opacity: 1; border-bottom: 2px solid var(--vscode-focusBorder); }
  .panel { display: none; }
  .panel.active { display: block; }
  .row { display: flex; gap: 6px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
  label { min-width: 90px; opacity: 0.85; }
  input[type=text], input[type=number], select, textarea {
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    padding: 3px 6px; border-radius: 2px; font-family: inherit; font-size: 12px;
  }
  input[type=number] { width: 70px; }
  textarea { width: 100%; box-sizing: border-box; resize: vertical; }
  button {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; padding: 5px 10px; border-radius: 2px; cursor: pointer; font-size: 12px;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  #corpusPath, #corpusCreatePath { font-family: var(--vscode-editor-font-family); opacity: 0.8; font-size: 11px; word-break: break-all; }
  #log, #chatTranscript {
    background: var(--vscode-editor-background); color: var(--vscode-editor-foreground);
    font-family: var(--vscode-editor-font-family); font-size: 11px; padding: 6px;
    overflow-y: auto; white-space: pre-wrap; border: 1px solid var(--vscode-panel-border);
  }
  #log { height: 220px; }
  #chatTranscript { height: 280px; margin-bottom: 8px; }
  .status { font-weight: bold; font-size: 12px; }
  .status.idle { color: var(--vscode-descriptionForeground); }
  .status.running { color: var(--vscode-charts-green); }
  .note { opacity: 0.7; font-size: 11px; margin: 4px 0 8px; }
  fieldset { border: 1px solid var(--vscode-panel-border); margin-bottom: 10px; }
  legend { font-size: 11px; opacity: 0.8; }
</style>
</head>
<body>
  <h3>AI Trainer</h3>
  <div class="note">General-purpose - configure Model/Corpus directories and the Train/Chat commands in Settings (search "AI Trainer") for whatever you're actually training. Defaults match Yggdrasil Suite/Scipio's own real, working setup.</div>
  <div class="tabs">
    <div class="tab active" data-tab="train">Train</div>
    <div class="tab" data-tab="corpus">Corpus</div>
    <div class="tab" data-tab="chat">Chat</div>
  </div>

  <fieldset>
    <legend>Model &amp; adapter</legend>
    <div class="row">
      <label>Model</label><select id="modelSelect"></select>
      <button id="detectModelsBtn" title="Rescans the configured models directory and the local Ollama daemon">Detect Models</button>
    </div>
    <div class="row">
      <button id="addModelBtn">Add Model...</button>
      <button id="removeModelBtn">Remove Model...</button>
    </div>
    <div class="row"><label>Adapter path</label><input type="text" id="adapterPath" placeholder="path to save/resume the trained adapter/checkpoint"></div>
    <div class="row"><label>Rank</label><input type="number" id="rank" value="4"><label>Alpha</label><input type="number" id="alpha" value="8"></div>
  </fieldset>

  <div id="train" class="panel active">
    <div class="row">
      <label>Training Method</label>
      <select id="methodSelect">
        <option value="lora">LoRA (real, verified default - Yggdrasil Suite's own working command)</option>
        <option value="full">Full Fine-Tune (edit the command below for your own real setup)</option>
        <option value="custom">Custom (uses aiTrainer.trainCommand from Settings)</option>
      </select>
    </div>
    <div class="row"><label>Command</label></div>
    <textarea id="commandBox" rows="2" style="width:100%"></textarea>
    <div class="note">Placeholders substituted before running: \${model}, \${corpus}, \${adapterPath}, \${epochs}, \${learningRate}, \${rank}, \${alpha}. Editing this only changes THIS run, not your saved Settings.</div>
    <div class="row">
      <label>Epochs</label><input type="number" id="epochs" value="1" min="1">
      <label>LR</label><input type="number" id="lr" value="0.0003" step="0.0001">
    </div>
    <div class="row"><label>Corpus</label><select id="corpusSelect"><option value="">(select a corpus)</option></select><button id="refreshCorpusBtn" title="Rescans the configured corpus directory for new files">Refresh</button></div>
    <div class="row"><button id="selectBtn">Browse for another file...</button></div>
    <div class="row">
      <button id="startBtn" disabled>Start Training</button>
      <button id="stopBtn" disabled>Stop</button>
    </div>
    <div class="row"><span id="statusText" class="status idle">idle</span></div>
    <div id="log"></div>
  </div>

  <div id="corpus" class="panel">
    <div class="row"><button id="newCorpusBtn">New Corpus...</button></div>
    <div class="note">Opens a blank real .jsonl file in the editor - paste in lines from Claude, ChatGPT, Gemini, Copilot, or Ollama and save. Fastest path if you're pasting from elsewhere.</div>
    <div class="note" style="margin-top:0">Or build one entry at a time below instead:</div>
    <div class="row"><label>Instruction</label></div>
    <textarea id="corpusInstruction" rows="2"></textarea>
    <div class="row" style="margin-top:6px"><label>Input (optional)</label></div>
    <textarea id="corpusInput" rows="2"></textarea>
    <div class="row" style="margin-top:6px"><label>Output</label></div>
    <textarea id="corpusOutput" rows="3"></textarea>
    <div class="row" style="margin-top:8px">
      <button id="addEntryBtn">Add Entry to Corpus...</button>
      <span id="corpusCreatePath"></span>
    </div>
    <div class="row"><span id="corpusCount"></span></div>
  </div>

  <div id="chat" class="panel">
    <div class="note">Runs the configured aiTrainer.chatCommand fresh per message - for a model that reloads from disk each time, expect real delay, not live chat speed.</div>
    <div id="chatTranscript"></div>
    <div class="row">
      <input type="text" id="chatInput" placeholder="Ask your model something..." style="flex:1">
      <button id="sendChatBtn">Send</button>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let corpusPath = "";
    let corpusCreatePath = "";

    document.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
        document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
        tab.classList.add("active");
        document.getElementById(tab.dataset.tab).classList.add("active");
      });
    });

    const modelSelect = document.getElementById("modelSelect");
    const adapterPathEl = document.getElementById("adapterPath");
    const rankEl = document.getElementById("rank");
    const alphaEl = document.getElementById("alpha");

    document.getElementById("detectModelsBtn").addEventListener("click", () => vscode.postMessage({ type: "detectModels" }));
    document.getElementById("addModelBtn").addEventListener("click", () => vscode.postMessage({ type: "addModel" }));
    document.getElementById("removeModelBtn").addEventListener("click", () => vscode.postMessage({ type: "removeModel" }));

    // --- Train tab ---
    const logEl = document.getElementById("log");
    const corpusSelect = document.getElementById("corpusSelect");
    const startBtn = document.getElementById("startBtn");
    const stopBtn = document.getElementById("stopBtn");
    const statusText = document.getElementById("statusText");

    corpusSelect.addEventListener("change", () => {
      corpusPath = corpusSelect.value;
      startBtn.disabled = !corpusPath;
    });
    document.getElementById("refreshCorpusBtn").addEventListener("click", () => vscode.postMessage({ type: "ready" }));
    document.getElementById("selectBtn").addEventListener("click", () => vscode.postMessage({ type: "selectCorpus" }));

    // Real, direct instruction: "theres different ways to train as well
    // yes? Lora vs I don't know what else. Add in those options." LoRA
    // is the one real, verified command (Yggdrasil Suite's own working
    // pipeline) - Full Fine-Tune is an honest, editable STARTING SHAPE
    // for whatever your own real full-finetune script expects, not a
    // tested command. Custom leaves the box blank so Settings' own
    // aiTrainer.trainCommand is used unchanged.
    const METHOD_PRESETS = {
      lora: "cargo run -p bl-lora --release --example train_data_adapters -- \${model} \${adapterPath} \${corpus} --epochs \${epochs} --lr \${learningRate} --rank \${rank} --alpha \${alpha} --resume-from \${adapterPath}",
      full: "python train_full_finetune.py --model \${model} --data \${corpus} --output \${adapterPath} --epochs \${epochs} --lr \${learningRate}  # EDIT ME: this is a shape/example, not a verified script - point it at your own real training code",
      custom: "",
    };
    const methodSelect = document.getElementById("methodSelect");
    const commandBox = document.getElementById("commandBox");
    methodSelect.addEventListener("change", () => {
      commandBox.value = METHOD_PRESETS[methodSelect.value] || "";
    });
    commandBox.value = METHOD_PRESETS.lora;

    startBtn.addEventListener("click", () => {
      vscode.postMessage({
        type: "startTraining",
        corpusPath,
        modelDir: modelSelect.value,
        adapterPath: adapterPathEl.value,
        epochs: Number(document.getElementById("epochs").value),
        lr: Number(document.getElementById("lr").value),
        rank: Number(rankEl.value),
        alpha: Number(alphaEl.value),
        commandOverride: commandBox.value.trim() || undefined,
      });
    });
    stopBtn.addEventListener("click", () => vscode.postMessage({ type: "stopTraining" }));

    function setRunning(running) {
      startBtn.disabled = running || !corpusPath;
      stopBtn.disabled = !running;
      statusText.textContent = running ? "training..." : "idle";
      statusText.className = "status " + (running ? "running" : "idle");
    }

    // --- Corpus tab ---
    document.getElementById("newCorpusBtn").addEventListener("click", () => vscode.postMessage({ type: "newCorpus" }));
    document.getElementById("addEntryBtn").addEventListener("click", () => {
      vscode.postMessage({
        type: "saveCorpusEntry",
        instruction: document.getElementById("corpusInstruction").value,
        input: document.getElementById("corpusInput").value,
        output: document.getElementById("corpusOutput").value,
        targetPath: corpusCreatePath || undefined,
      });
    });

    // --- Chat tab ---
    const chatTranscript = document.getElementById("chatTranscript");
    const chatInput = document.getElementById("chatInput");
    const sendChatBtn = document.getElementById("sendChatBtn");

    function appendChat(who, text) {
      const div = document.createElement("div");
      div.style.marginBottom = "8px";
      div.innerHTML = "<b>" + who + ":</b> " + text.replace(/</g, "&lt;");
      chatTranscript.appendChild(div);
      chatTranscript.scrollTop = chatTranscript.scrollHeight;
    }

    sendChatBtn.addEventListener("click", () => {
      const text = chatInput.value.trim();
      if (!text) return;
      appendChat("You", text);
      appendChat("Model", "(thinking...)");
      sendChatBtn.disabled = true;
      vscode.postMessage({
        type: "sendChatMessage",
        text,
        modelDir: modelSelect.value,
        adapterPath: adapterPathEl.value,
        rank: Number(rankEl.value),
        alpha: Number(alphaEl.value),
        maxNewTokens: 200,
      });
      chatInput.value = "";
    });
    chatInput.addEventListener("keydown", (e) => { if (e.key === "Enter") sendChatBtn.click(); });

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message.type === "models") {
        const previousModel = modelSelect.value;
        modelSelect.innerHTML = "";
        for (const m of message.models) {
          const opt = document.createElement("option");
          opt.value = m.path; opt.textContent = m.name;
          modelSelect.appendChild(opt);
        }
        if (previousModel && Array.from(modelSelect.options).some((o) => o.value === previousModel)) {
          modelSelect.value = previousModel;
        }
      } else if (message.type === "corpora") {
        const previous = corpusSelect.value;
        corpusSelect.innerHTML = '<option value="">(select a corpus)</option>';
        for (const c of message.corpora) {
          const opt = document.createElement("option");
          opt.value = c; opt.textContent = c;
          corpusSelect.appendChild(opt);
        }
        if (previous && message.corpora.includes(previous)) {
          corpusSelect.value = previous;
        }
      } else if (message.type === "corpusSelected") {
        corpusPath = message.path;
        let opt = Array.from(corpusSelect.options).find((o) => o.value === corpusPath);
        if (!opt) {
          opt = document.createElement("option");
          opt.value = corpusPath; opt.textContent = corpusPath;
          corpusSelect.appendChild(opt);
        }
        corpusSelect.value = corpusPath;
        startBtn.disabled = false;
      } else if (message.type === "corpusEntrySaved") {
        corpusCreatePath = message.path;
        document.getElementById("corpusCreatePath").textContent = corpusCreatePath;
        document.getElementById("corpusCount").textContent = message.count + " real entries in this file";
        document.getElementById("corpusInstruction").value = "";
        document.getElementById("corpusInput").value = "";
        document.getElementById("corpusOutput").value = "";
      } else if (message.type === "corpusLog") {
        document.getElementById("corpusCount").textContent = message.line;
      } else if (message.type === "log") {
        logEl.textContent += message.line + "\\n";
        logEl.scrollTop = logEl.scrollHeight;
      } else if (message.type === "status") {
        setRunning(message.running);
      } else if (message.type === "chatResponse") {
        chatTranscript.lastChild.remove();
        const tokens = message.tokensGenerated !== undefined ? " (" + message.tokensGenerated + " tokens)" : "";
        appendChat("Model", message.response + tokens);
        sendChatBtn.disabled = false;
      } else if (message.type === "chatError") {
        chatTranscript.lastChild.remove();
        appendChat("Error", message.error);
        sendChatBtn.disabled = false;
      }
    });

    setRunning(false);
    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
}
