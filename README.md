# AI Trainer

A real, general-purpose VS Code extension for training and chatting with
local AI models - pick a corpus file, configure the training/chat
command for whatever you're actually running, start/stop a real
process, and watch live output. It does not implement training itself;
it's a real UI over commands you configure, so it works with LoRA
fine-tuning, full fine-tuning, or anything else you can invoke from a
shell.

**Status**: early, functional, actively developed. Built by Bachlaude,
open source under the MIT License (see `LICENSE`).

## Why

Training a small local model usually means juggling a terminal, a
scattered set of corpus files, and remembering the right command-line
flags each time. This extension puts that in one place: a real sidebar
panel with model/corpus selection, one-click start/stop, and live
output - without assuming you're using one specific framework or
project layout.

## Features

- **Train tab**: pick a model and corpus, choose a training method
  (LoRA / Full Fine-Tune / Custom), start/stop a real tracked process,
  watch live stdout/stderr.
- **Corpus tab**: create a new, blank corpus file to paste into directly
  from any AI chat (Claude, ChatGPT, Gemini, Copilot, Ollama - anywhere
  you generate training examples), or build entries one at a time with a
  simple instruction/input/output form.
- **Chat tab**: send a prompt to your configured model and see the real
  reply, useful for sanity-checking a checkpoint without leaving VS
  Code.
- **Model detection**: automatically finds models in a configured
  project directory AND your local Ollama installation (if running);
  add anything else manually via "Add Model...".
- Every real button has a visible label - keyboard users can still move
  fast, but nothing requires memorizing a shortcut to discover it.

## Install

1. Clone this repository.
2. `npm install`
3. `npm run compile`
4. `npx @vscode/vsce package` to produce a `.vsix`, then
   `code --install-extension <file>.vsix` - or press F5 in VS Code to
   run it in an Extension Development Host for testing.

## Setup

Open Settings (Ctrl+,) and search "AI Trainer". At minimum, set:

- `aiTrainer.workingDirectory` - where your training commands should run
  from (defaults to your open workspace folder if left blank).
- `aiTrainer.modelsDir` / `aiTrainer.corpusDir` - where your models and
  corpus files live.
- `aiTrainer.trainCommand` / `aiTrainer.chatCommand` - the real shell
  commands for your own project. Defaults point at a working LoRA
  example command - edit them for your own setup.

See `FAQ.md` for real hardware requirements, warnings, and known issues
found during development.

## Disclaimer

This software is provided "as is," without warranty of any kind - see
`LICENSE` for the full text. Training runs it starts are real processes
on your machine; review any command you configure before running it,
especially if copied from somewhere you don't fully trust.

## Feedback and bug reports

Genuinely wanted - please open a GitHub Issue. See `CONTRIBUTING.md`
for the bug report format this project uses.
