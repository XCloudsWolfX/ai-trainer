# Changelog

All notable changes to AI Trainer are documented here.

## [0.3.0] - 2026-09-11

### Added
- Real corpus repository: a fixed `~/AITrainer/Training Corpus/` folder, auto-created and seeded with an example file, discoverable regardless of which project workspace is open.
- Native `.bach` file type for corpus files (plain JSONL underneath, unchanged) - distinctive and instantly recognizable, registered for real JSON syntax highlighting. `.jsonl` remains fully supported for backward compatibility.
- "Detect Corpora" button - scans every known corpus location (the fixed home folder, an explicitly configured directory, and a project's own `docs/corpora` if present) instead of trusting one hardcoded path.
- Per-corpus run history - each corpus's most recent real run (exit code, timestamp, a real tail of actual output) is tracked and shown in its own dropdown entry.
- Auto-generated adapter paths - selecting a model now auto-fills a real, deterministic adapter/checkpoint path (`~/AITrainer/Adapters/<model>.safetensors`) instead of requiring manual entry. Still a plain, editable field.
- Real, contextual hover tooltips throughout: Model, Adapter path, Rank, Alpha, Training Method, Command, Epochs, LR, Corpus, and the corpus-entry fields all explain what they actually do in this tool.
- `aiTrainer.chatCommand` is now a real, declared Settings entry (it was already used in code but had never been registered, so it never showed up in the Settings UI).

### Fixed
- The corpus dropdown coming up empty for anyone whose open workspace wasn't the exact folder the corpus path was relative to - corpus location is no longer workspace-dependent by default.

### Security
- `Training Corpus/` and `Debug/` both happen to sit inside this repo's own root by coincidence of path, and this repo is public - both are now excluded via `.gitignore` so real training data or debug screenshots can never end up in a public commit.

## [0.2.0] - 2026-09-11

### Changed
- Generalized from a Yggdrasil Suite/Scipio-specific tool ("Data Trainer") into a real, standalone, general-purpose extension for training or chatting with any local AI model. Nothing assumes Rust/Cargo, LoRA, or one project's folder layout anymore - the working directory, model/corpus locations, and the training/chat commands themselves are all plain, editable Settings (substituted via `${placeholder}` tokens). The defaults still point at Yggdrasil Suite's own real, working commands as a starting example, not a requirement.
- Relocated out of the Yggdrasil Suite folder entirely into its own separate project.

### Added
- Real model detection: scans a configured models directory, queries a local Ollama daemon's own `/api/tags`, and supports manually-added models (with a real "Add Model.../Remove Model..." flow) for anything neither finds.
- Multiple training-method presets (LoRA, Full Fine-Tune, Custom) with an editable per-run command box.
- A Chat tab for talking to a trained model directly from the panel.

### Fixed
- Working-directory detection now also checks a workspace folder's own immediate subdirectories (not just the folder itself) for a `Cargo.toml`, so opening a parent folder containing multiple sibling projects still works.

## [0.1.0] - 2026-09-11

### Added
- Initial release: a real Activity Bar panel (not a command-palette-only feature) for training "Data," the native LoRA model in Yggdrasil Suite/Scipio - select a corpus file, start/stop a real tracked training process, watch live output.
