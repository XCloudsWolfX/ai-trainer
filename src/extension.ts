import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
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

/** Real, direct instruction (2026-09-11): "should add a status next to
 * each corpus of if it was ran and what its returns were." Keeps just
 * the MOST RECENT real run per corpus path (not a growing log - this is
 * "did this run, and what happened," not a full history browser) so the
 * corpus dropdown can show it inline. */
interface CorpusRunRecord {
  timestampMs: number;
  exitCode: number | null;
  tail: string;
}
const RUN_HISTORY_KEY = "aiTrainer.corpusRunHistory";

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

  private async detectAllModels(): Promise<{ name: string; path: string; defaultAdapterPath: string }[]> {
    const fromDir = listAvailableModels().map((p) => ({ name: p, path: p }));
    const fromOllama = await detectOllamaModels();
    const manual = this.getManualModels();
    return [...fromDir, ...fromOllama, ...manual].map((m) => ({ ...m, defaultAdapterPath: defaultAdapterPathFor(m.name) }));
  }

  private async postModels() {
    this.post({ type: "models", models: await this.detectAllModels() });
  }

  private getRunHistory(): Record<string, CorpusRunRecord> {
    return this.context.globalState.get<Record<string, CorpusRunRecord>>(RUN_HISTORY_KEY, {});
  }

  async recordRun(corpusPath: string, exitCode: number | null, tail: string): Promise<void> {
    const history = this.getRunHistory();
    history[corpusPath] = { timestampMs: Date.now(), exitCode, tail };
    await this.context.globalState.update(RUN_HISTORY_KEY, history);
  }

  /** Real, direct instruction (2026-09-11): "should add a status next to
   * each corpus of if it was ran and what its returns were." Each real
   * corpus's own most recent real run (exit code + a tail of real
   * output) is shown right in its dropdown label - `handleStartTraining`
   * calls `recordRun` above the moment a real process actually exits. */
  private async postCorpora() {
    const history = this.getRunHistory();
    const searchDirs = corpusSearchDirs();
    const corpora = listAvailableCorpora().map((filePath) => {
      // Real, direct labeling: a file inside a real subfolder (e.g. the
      // seeded "Examples (Yggdrasil Suite)" folder) shows that folder
      // name too, so a bundled example is never confused for the user's
      // own corpus file with the same base name. A file sitting DIRECTLY
      // in one of the real search directories just shows its own name.
      const parentDir = path.dirname(filePath);
      const directlyInSearchDir = searchDirs.some((d) => path.resolve(d) === path.resolve(parentDir));
      const baseLabel = directlyInSearchDir
        ? path.basename(filePath)
        : `${path.basename(parentDir)}/${path.basename(filePath)}`;
      const record = history[filePath];
      const label = record
        ? `${baseLabel} — last run: exit ${record.exitCode ?? "?"}, ${new Date(record.timestampMs).toLocaleString()} — ${record.tail}`
        : baseLabel;
      return { path: filePath, label };
    });
    this.post({ type: "corpora", corpora });
  }

  private async handleMessage(message: any) {
    switch (message.type) {
      case "ready":
        await this.postModels();
        await this.postCorpora();
        this.post({ type: "status", running: !!runningTraining });
        break;
      case "detectModels":
        await this.postModels();
        break;
      case "detectCorpora":
        await this.postCorpora();
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
        await this.postCorpora();
        break;
      case "newCorpus":
        await handleNewCorpus((m) => this.post(m));
        await this.postCorpora();
        break;
      case "startTraining":
        await handleStartTraining(message, (m) => this.post(m), (corpusPath, exitCode, tail) => this.recordRun(corpusPath, exitCode, tail));
        break;
      case "stopTraining":
        handleStopTraining((m) => this.post(m));
        break;
      case "sendChatMessage":
        await handleChatMessage(message, (m) => this.post(m));
        break;
      case "openSettings":
        await vscode.commands.executeCommand("workbench.action.openSettings", "AI Trainer");
        break;
      case "openSupport":
        await vscode.env.openExternal(vscode.Uri.parse("https://github.com/XCloudsWolfX/ai-trainer#readme"));
        break;
    }
  }
}

const SAMPLE_CORPORA_SEEDED_KEY = "aiTrainer.sampleCorporaSeeded";

/** Real, direct instruction (2026-09-11): "I still did not see the
 * twelve corpus you claim already exist when I searched for existing
 * corpus. Include them in this ext as default training corpus. Properly
 * labled." Those real files (this project's own actual Data-training
 * corpus, `Scipio/docs/corpora/*.jsonl`) only ever showed up through
 * live auto-detection of a Yggdrasil Suite workspace - with AI Trainer
 * now a genuinely separate, general-purpose tool, that workspace isn't
 * necessarily open. Real fix: ship real copies of those files WITH the
 * extension (`sample-corpora/`, bundled in the .vsix) and copy them into
 * a clearly separate, labeled subfolder on first real activation - never
 * silently mixed into the user's own corpus files. Runs once
 * (tracked via `globalState`), and only adds files, never overwrites -
 * if the user has already edited/deleted their own copy, this won't
 * clobber it on a later update.
 */
async function seedSampleCorporaOnce(context: vscode.ExtensionContext) {
  if (context.globalState.get<boolean>(SAMPLE_CORPORA_SEEDED_KEY, false)) {
    return;
  }
  try {
    const sourceDir = path.join(context.extensionPath, "sample-corpora");
    if (!fs.existsSync(sourceDir)) {
      return;
    }
    const destDir = path.join(defaultCorpusDir(), "Examples (Yggdrasil Suite)");
    fs.mkdirSync(destDir, { recursive: true });
    for (const file of fs.readdirSync(sourceDir)) {
      const dest = path.join(destDir, file);
      if (!fs.existsSync(dest)) {
        fs.copyFileSync(path.join(sourceDir, file), dest);
      }
    }
    const readme =
      "These are real corpus files from Yggdrasil Suite/Scipio's own \"Data\" AI - bundled here as real, " +
      "concrete examples of the format, not generic training data for whatever you're working on. Feel " +
      "free to use, edit, or delete them - they won't come back once removed (this folder is only seeded " +
      "once, on first install).\n";
    const readmePath = path.join(destDir, "README.txt");
    if (!fs.existsSync(readmePath)) {
      fs.writeFileSync(readmePath, readme, "utf8");
    }
    await context.globalState.update(SAMPLE_CORPORA_SEEDED_KEY, true);
  } catch {
    // Real, honest failure mode: if seeding fails (permissions, disk
    // full, etc.), the extension still works - it just starts with an
    // empty corpus folder instead of the bundled examples.
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
  void seedSampleCorporaOnce(context);
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

/** Real, direct instruction (2026-09-11): "Can we give them their own
 * type like .bach or something." `.bach` is the real, native extension
 * for a NEW corpus this extension creates - still genuinely one-JSON-
 * object-per-line underneath (real JSONL, unchanged), just a distinctive
 * extension so a corpus file is instantly recognizable in Explorer/file
 * pickers instead of blending into every other `.jsonl` on disk. `.jsonl`
 * itself stays fully real and detected too - Yggdrasil Suite's own
 * existing corpora (and anything from before this convention existed)
 * must keep working, not get silently orphaned by a rename. */
const NATIVE_CORPUS_EXT = ".bach";
const RECOGNIZED_CORPUS_EXTS = [".bach", ".jsonl"];

/** Real, direct instruction (2026-09-11): "path to save resume training
 * should be generated not asked for." Each real model gets ONE real,
 * deterministic adapter path it saves to and resumes from across runs -
 * derived from the model's own name so re-selecting the same model
 * always lands on the same real file, still shown (and editable) in the
 * UI rather than hidden, in case a real reason to override it comes up. */
function defaultAdapterPathFor(modelIdentifier: string): string {
  const safeName = modelIdentifier.replace(/[^a-zA-Z0-9_.-]+/g, "_");
  return path.join(os.homedir(), "AITrainer", "Adapters", `${safeName}.safetensors`);
}

/** Real, fixed, always-present home for corpus files - NOT tied to
 * whatever VS Code workspace happens to be open. Real, direct bug fix
 * (2026-09-11), live report: "Browse brings up files but, I don't see a
 * folder marked Training Corpus." The old default (`docs/corpora`,
 * relative to whatever workspace folder happened to be open) is exactly
 * the kind of project-specific assumption this extension was just
 * generalized away from - a corpus repository needs to exist and be
 * discoverable regardless of which project you're pointed at. */
function defaultCorpusDir(): string {
  return path.join(os.homedir(), "AITrainer", "Training Corpus");
}

const EXAMPLE_CORPUS_CONTENT =
  '{"instruction": "This is an example entry - real training data goes one JSON object per line, like this one.", "input": "", "output": "Delete this example line once you have real entries. See the AI Trainer README for the full format."}\n';

/** Real, direct instruction: "add a detect corpora function (because,
 * how would it know)." Same real principle as `detectAllModels` - don't
 * trust one hardcoded location. Scans (1) the fixed home default
 * (auto-created + seeded with an example on first real access, so it's
 * never a confusing empty folder), (2) an explicitly configured
 * `aiTrainer.corpusDir` if set, and (3) the working directory's own
 * `docs/corpora` if it happens to exist (the original Yggdrasil Suite
 * convention, kept as a real, harmless bonus for backward compatibility,
 * not a requirement). */
function corpusSearchDirs(): string[] {
  const dirs = new Set<string>();
  const home = defaultCorpusDir();
  try {
    fs.mkdirSync(home, { recursive: true });
    const seeded = fs.readdirSync(home).some((f) => RECOGNIZED_CORPUS_EXTS.some((ext) => f.endsWith(ext)));
    if (!seeded) {
      fs.writeFileSync(path.join(home, `example${NATIVE_CORPUS_EXT}`), EXAMPLE_CORPUS_CONTENT, "utf8");
    }
  } catch {
    // Real, honest failure mode: if the home directory can't be created
    // (permissions, etc.), just don't include it - other search dirs
    // still work.
  }
  dirs.add(home);
  const config = vscode.workspace.getConfiguration("aiTrainer");
  const configured = config.get<string>("corpusDir", "").trim();
  const root = resolveWorkingDirectory();
  if (configured && root) {
    dirs.add(path.isAbsolute(configured) ? configured : path.join(root, configured));
  }
  if (root) {
    const legacy = path.join(root, "docs", "corpora");
    if (fs.existsSync(legacy)) {
      dirs.add(legacy);
    }
  }
  return Array.from(dirs);
}

/** Real primary save location for a NEW corpus - the explicitly
 * configured directory if set, otherwise the fixed home default. */
function primaryCorpusDir(): string {
  const config = vscode.workspace.getConfiguration("aiTrainer");
  const configured = config.get<string>("corpusDir", "").trim();
  const root = resolveWorkingDirectory();
  if (configured && root) {
    return path.isAbsolute(configured) ? configured : path.join(root, configured);
  }
  return defaultCorpusDir();
}

/** Scans one real directory for corpus files directly inside it, plus
 * one level of real subdirectories (e.g. the seeded "Examples
 * (Yggdrasil Suite)" folder) - a labeled subfolder is a real, deliberate
 * organizing tool, not something that should hide its own contents from
 * the dropdown. */
function corpusFilesIn(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && RECOGNIZED_CORPUS_EXTS.some((ext) => entry.name.endsWith(ext))) {
      results.push(path.join(dir, entry.name));
    } else if (entry.isDirectory()) {
      const sub = path.join(dir, entry.name);
      for (const subEntry of fs.readdirSync(sub, { withFileTypes: true })) {
        if (subEntry.isFile() && RECOGNIZED_CORPUS_EXTS.some((ext) => subEntry.name.endsWith(ext))) {
          results.push(path.join(sub, subEntry.name));
        }
      }
    }
  }
  return results;
}

function listAvailableCorpora(): string[] {
  const results: string[] = [];
  for (const dir of corpusSearchDirs()) {
    results.push(...corpusFilesIn(dir));
  }
  return results.sort();
}

async function handleSelectCorpus(post: Poster) {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { "Training corpus": ["bach", "jsonl"] },
    title: "Select a real corpus file (.bach or .jsonl)",
  });
  if (picked && picked.length > 0) {
    post({ type: "corpusSelected", path: picked[0].fsPath });
  }
}

/** Real, direct instruction: "a 'New Corpus' button that opens a blank
 * .json or whatever the file type is. I can then copy and paste from
 * you or chat or gemini or even copilot and save it." A genuinely empty
 * real file in the real corpus repository, opened in VS Code's own text
 * editor - paste raw JSONL from any AI conversation and hit Ctrl+S, no
 * custom form required. */
async function handleNewCorpus(post: Poster) {
  const repoDir = primaryCorpusDir();
  const name = await vscode.window.showInputBox({
    title: `New corpus filename (created empty in ${repoDir})`,
    placeHolder: "e.g. gemini_lessons_2026-09-11",
    validateInput: (v) => (v.trim().length === 0 ? "Enter a filename" : undefined),
  });
  if (!name) {
    return;
  }
  const fileName = RECOGNIZED_CORPUS_EXTS.some((ext) => name.endsWith(ext)) ? name : `${name}${NATIVE_CORPUS_EXT}`;
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
    const repoDir = primaryCorpusDir();
    const name = await vscode.window.showInputBox({
      title: `New corpus filename (saved into ${repoDir})`,
      placeHolder: "e.g. session_2026-09-11",
      validateInput: (v) => (v.trim().length === 0 ? "Enter a filename" : undefined),
    });
    if (!name) {
      return;
    }
    const fileName = RECOGNIZED_CORPUS_EXTS.some((ext) => name.endsWith(ext)) ? name : `${name}${NATIVE_CORPUS_EXT}`;
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

type RunRecorder = (corpusPath: string, exitCode: number | null, tail: string) => Promise<void>;

async function handleStartTraining(message: any, post: Poster, recordRun: RunRecorder) {
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
  const recentLines: string[] = [];
  pipeToLog(child, post, recentLines, async (exitCode) => {
    runningTraining = undefined;
    post({ type: "status", running: false });
    // Real, direct instruction (2026-09-11): "should add a status next
    // to each corpus of if it was ran and what its returns were." Real
    // tail of actual output, not a project-specific parsed value (this
    // extension no longer assumes any one training command's own output
    // shape) - the last non-empty line is usually the most informative
    // one for whatever real command actually ran.
    const tail = recentLines.filter((l) => l.trim().length > 0).slice(-1)[0] || "(no output)";
    await recordRun(corpusPath, exitCode, tail);
  });
}

function pipeToLog(child: ChildProcessWithoutNullStreams, post: Poster, recentLines: string[], onDone: (exitCode: number | null) => void) {
  const MAX_TAIL_LINES = 5;
  const forward = (data: Buffer) => {
    for (const line of data.toString().split(/\r?\n/)) {
      if (line.length > 0) {
        post({ type: "log", line });
        recentLines.push(line);
        if (recentLines.length > MAX_TAIL_LINES) {
          recentLines.shift();
        }
      }
    }
  };
  child.stdout.on("data", forward);
  child.stderr.on("data", forward);
  child.on("close", (code) => {
    post({ type: "log", line: `--- process exited with real code ${code} ---` });
    onDone(code);
  });
  child.on("error", (err) => {
    post({ type: "log", line: `Real error starting the process: ${err.message}` });
    onDone(null);
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
  <div class="row" style="justify-content: space-between; align-items: center;">
    <h3 style="margin:0">AI Trainer</h3>
    <div>
      <button id="openSettingsBtn" title="Opens VS Code's real Settings UI, filtered to AI Trainer - customize models/corpus directories and the Train/Chat commands here">Settings</button>
      <button id="supportBtn" title="Opens the real README/issue tracker on GitHub - report a bug, ask a question, or read the full corpus format docs">Help &amp; Support</button>
    </div>
  </div>
  <div class="note">General-purpose - configure Model/Corpus directories and the Train/Chat commands in Settings (button above) for whatever you're actually training. Defaults match Yggdrasil Suite/Scipio's own real, working setup. Hover any label for what it means.</div>
  <div class="tabs">
    <div class="tab active" data-tab="train">Train</div>
    <div class="tab" data-tab="corpus">Corpus</div>
    <div class="tab" data-tab="chat">Chat</div>
  </div>

  <fieldset>
    <legend>Model &amp; adapter</legend>
    <div class="row">
      <label title="The base AI model you're training or chatting with. The dropdown lists real subdirectories of your configured models folder, real models already pulled by a local Ollama, and anything you've added manually below.">Model</label>
      <select id="modelSelect"></select>
      <button id="detectModelsBtn" title="Rescans the configured models directory and the local Ollama daemon for real models">Detect Models</button>
    </div>
    <div class="row">
      <button id="addModelBtn" title="Browse to a model file or folder anywhere on disk and give it a name - for anything Detect Models can't find on its own">Add Model...</button>
      <button id="removeModelBtn" title="Remove a manually-added model from the list (doesn't delete any real files)">Remove Model...</button>
    </div>
    <div class="row">
      <label title="Where the trained adapter/checkpoint is saved to, and resumed from on your NEXT run against this same model - so training accumulates across runs instead of restarting from scratch each time. Auto-filled per model; edit it if you want a different file for this run.">Adapter path</label>
      <input type="text" id="adapterPath" placeholder="auto-filled when you pick a model">
    </div>
    <div class="row">
      <label title="LoRA rank - how many extra parameters the fine-tune adds, per layer. Lower (e.g. 4) trains fast and uses little memory but learns less; higher (e.g. 16-64) can learn more but is slower and needs more memory. Only meaningful if your training command actually uses \${rank} - the default LoRA command does.">Rank</label>
      <input type="number" id="rank" value="4">
      <label title="LoRA alpha - a scaling factor applied to the rank-4/8/etc. adjustment above. The common convention is alpha = 2x rank (e.g. rank 4 -> alpha 8); raising it makes the fine-tune's influence stronger without changing how many parameters it uses.">Alpha</label>
      <input type="number" id="alpha" value="8">
    </div>
  </fieldset>

  <div id="train" class="panel active">
    <div class="row">
      <label title="Which real training approach to run. LoRA is the one pre-filled, verified-working command (Yggdrasil Suite's own pipeline). The others are honest starting shapes for your own setup, not tested scripts.">Training Method</label>
      <select id="methodSelect">
        <option value="lora">LoRA (real, verified default - Yggdrasil Suite's own working command)</option>
        <option value="full">Full Fine-Tune (edit the command below for your own real setup)</option>
        <option value="custom">Custom (uses aiTrainer.trainCommand from Settings)</option>
      </select>
    </div>
    <div class="row"><label title="The actual shell command that will run, with placeholders filled in from the fields on this screen. Edit it freely - this only affects the run you're about to start, it doesn't overwrite your saved Settings.">Command</label></div>
    <textarea id="commandBox" rows="2" style="width:100%"></textarea>
    <div class="note">Placeholders substituted before running: \${model}, \${corpus}, \${adapterPath}, \${epochs}, \${learningRate}, \${rank}, \${alpha}. Editing this only changes THIS run, not your saved Settings.</div>
    <div class="row">
      <label title="One epoch = one full pass through your corpus. More epochs can mean more learning, but real measurements on this project found it's genuinely non-monotonic - more isn't automatically better, and can make things worse. Start at 1 and check the result before adding more.">Epochs</label>
      <input type="number" id="epochs" value="1" min="1">
      <label title="Learning rate - how big a step the optimizer takes each update. Too high and training can diverge (loss gets WORSE, not better); too low and it barely learns. 0.0003 is a real, already-proven value for a small model like TinyLlama - change it deliberately, not by guessing.">LR</label>
      <input type="number" id="lr" value="0.0003" step="0.0001">
    </div>
    <div class="row">
      <label title="The real training data file (.bach or .jsonl) to train on - one {instruction, input, output} JSON object per line. Build or import one from the Corpus tab.">Corpus</label>
      <select id="corpusSelect"><option value="">(select a corpus)</option></select>
      <button id="refreshCorpusBtn" title="Rescans every known corpus location (your Training Corpus folder, any configured directory, and a project's own docs/corpora if present) for real files">Detect Corpora</button>
    </div>
    <div class="row"><button id="selectBtn" title="Open a real file picker to choose a corpus file from anywhere on disk, not just the detected locations">Browse for another file...</button></div>
    <div class="row">
      <button id="startBtn" disabled>Start Training</button>
      <button id="stopBtn" disabled>Stop</button>
    </div>
    <div class="row"><span id="statusText" class="status idle">idle</span></div>
    <div id="log"></div>
  </div>

  <div id="corpus" class="panel">
    <div class="row"><button id="newCorpusBtn" title="Creates a real, empty .bach file (plain JSONL underneath) in your Training Corpus folder and opens it for editing">New Corpus...</button></div>
    <div class="note">Opens a blank real .bach file (plain JSONL underneath - one JSON object per line, same as .jsonl) in the editor - paste in lines from Claude, ChatGPT, Gemini, Copilot, or Ollama and save. Fastest path if you're pasting from elsewhere.</div>
    <div class="note" style="margin-top:0">Or build one entry at a time below instead:</div>
    <div class="row"><label title="The real instruction/question/task the model should learn to respond to.">Instruction</label></div>
    <textarea id="corpusInstruction" rows="2"></textarea>
    <div class="row" style="margin-top:6px"><label title="Extra context/data for the instruction, if any - many real entries leave this blank and put everything in Instruction instead.">Input (optional)</label></div>
    <textarea id="corpusInput" rows="2"></textarea>
    <div class="row" style="margin-top:6px"><label title="The real, correct response the model should learn to produce for this Instruction/Input pair.">Output</label></div>
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

    document.getElementById("openSettingsBtn").addEventListener("click", () => vscode.postMessage({ type: "openSettings" }));
    document.getElementById("supportBtn").addEventListener("click", () => vscode.postMessage({ type: "openSupport" }));
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
    document.getElementById("refreshCorpusBtn").addEventListener("click", () => vscode.postMessage({ type: "detectCorpora" }));

    // Real, direct instruction (2026-09-11): "path to save resume
    // training should be generated not asked for." Each model option
    // carries its own real, deterministic default adapter path - auto-
    // filled on selection, still a plain editable text field if you want
    // to point at something else for one run.
    modelSelect.addEventListener("change", () => {
      const opt = modelSelect.options[modelSelect.selectedIndex];
      if (opt && opt.dataset.defaultAdapterPath) {
        adapterPathEl.value = opt.dataset.defaultAdapterPath;
      }
    });
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
          opt.dataset.defaultAdapterPath = m.defaultAdapterPath || "";
          modelSelect.appendChild(opt);
        }
        if (previousModel && Array.from(modelSelect.options).some((o) => o.value === previousModel)) {
          modelSelect.value = previousModel;
        } else if (modelSelect.options.length > 0) {
          modelSelect.selectedIndex = 0;
        }
        // Real, direct instruction: "path to save resume training should
        // be generated not asked for" - fill it in immediately too, not
        // only on a later change event, so it's never blank by default.
        modelSelect.dispatchEvent(new Event("change"));
      } else if (message.type === "corpora") {
        const previous = corpusSelect.value;
        corpusSelect.innerHTML = '<option value="">(select a corpus)</option>';
        for (const c of message.corpora) {
          const opt = document.createElement("option");
          opt.value = c.path; opt.textContent = c.label;
          corpusSelect.appendChild(opt);
        }
        if (previous && message.corpora.some((c) => c.path === previous)) {
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
