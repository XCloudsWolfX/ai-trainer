# Data Trainer

A real VS Code UI for training "Data" (the native LoRA model in
Yggdrasil Suite / Scipio) - pick a corpus file, start/stop a real
training run, watch live progress. No Claude Code required.

## Use

1. Open the Scipio folder as your VS Code workspace (the one with
   `Cargo.toml` in it).
2. Command Palette (Ctrl+Shift+P) → **Data Trainer: Open Panel**.
3. Click **Select Corpus File...** and pick a real `.jsonl` corpus file
   (see `docs/how_to_train_data_yourself.md` for how to make one with
   Gemini or ChatGPT).
4. Click **Start Training**. Real, live output streams into the panel as
   it runs.
5. **Stop** cancels the real, running process cleanly.

## Settings

`dataTrainer.scipioRoot`, `dataTrainer.modelDir`,
`dataTrainer.adapterPath`, `dataTrainer.epochs`,
`dataTrainer.learningRate` - see Settings → Extensions → Data Trainer.
Defaults match the real, already-proven values this project uses.

This extension is a real UI over the existing
`cargo run -p bl-lora --example train_data_adapters` pipeline - it does
not reimplement training itself.
