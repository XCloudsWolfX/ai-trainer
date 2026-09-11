# FAQ, warnings, and known issues

This tool is a real, thin UI over whatever training command *you*
configure - it doesn't ship a training implementation of its own. The
entries below are real lessons learned building and running local LoRA
training pipelines during this project's own development, kept here
honestly because the same failure modes are likely to recur for anyone
else training small local models.

## Hardware / machine requirements

- **CPU-only training works but is genuinely slow.** Real, measured
  cost on a small (1-3B parameter) model, CPU-only: roughly **3 hours
  per epoch** over a modest (dozens of examples) corpus on a mid-range
  laptop CPU. Budget accordingly - this is not a "few minutes" tool on
  CPU alone.
- **GPU acceleration helps a lot when available**, but respect your
  card's real VRAM limit. A single oversized matmul (e.g. a large LM
  head weight) can crash the GPU driver entirely (`DeviceLost`) on
  lower-VRAM cards (real, hit and fixed at 2GB VRAM) - if you see driver
  crashes during training, check whether your own training code caps
  per-operation buffer sizes, not just total model size.
- **Disk space adds up fast.** A single small (1-3B) model checkpoint is
  several GB; keeping multiple checkpoints/adapters across experiments
  can exhaust a modest drive quickly. Point `aiTrainer.workingDirectory`
  and your model paths at a drive with real free space, not assumed.
- **16GB+ system RAM is a reasonable baseline** for loading a 1-3B model
  checkpoint plus your OS/editor overhead comfortably.

## Real warnings before you start a run

- **A learning rate that's too high will make loss get WORSE, not
  better** - this is real and easy to hit by just picking a "round
  number" LR. If your first epoch's loss increases instead of
  decreases, stop and lower the LR (a 10x reduction is a reasonable
  first correction) rather than assuming more epochs will fix it.
- **More epochs is not automatically better.** A run that improved in
  epoch 1 can genuinely regress in epoch 2 at the same learning rate -
  this is real, observed behavior, not a hypothetical. If your training
  script only keeps the FINAL epoch's weights (many simple scripts do),
  a regression in the last epoch silently throws away a better,
  earlier checkpoint. Consider training one epoch at a time and
  checking the result before continuing, especially early on with a new
  corpus.
- **A model checkpoint missing its config file will fail to load** if
  your loader expects one (e.g. a real HuggingFace-style
  `config.json`) - if a checkpoint was saved without one (common when a
  checkpoint was originally loaded by inferring shape from the weights
  file alone), you may need to hand-author a minimal config with the
  real architecture values (hidden size, attention heads, layer count,
  etc.) before this tool's own training command can use it.
- **This tool does not keep a rollback history of checkpoints.** If your
  own training command overwrites a single adapter/checkpoint file each
  run (a common, simple design), there is currently no way to recover a
  better earlier checkpoint once a later, worse one has overwritten it.
  If this matters to you, have your own training script version its
  output files (e.g. include an epoch or timestamp in the filename)
  rather than always overwriting the same path.
- **A greedy/deterministic decoder can get stuck in a repetition loop**
  (repeating the same token or phrase indefinitely) - if your own
  generation/chat code doesn't already apply a repetition penalty, this
  is a real, common failure mode worth checking for before assuming a
  broken model.

## FAQ

**Q: Does this tool implement training itself?**
No. `aiTrainer.trainCommand` (and `aiTrainer.chatCommand`) are real
shell commands YOU configure - this extension just runs them, streams
their real output, and lets you start/stop/manage the pieces (model
selection, corpus files) around them.

**Q: Why is my model/corpus dropdown empty?**
Check that `aiTrainer.workingDirectory` resolves correctly - by
default this tool looks at your open VS Code workspace folder (and one
level of its subdirectories) for a project, but if nothing is found it
can come up empty. Set `aiTrainer.workingDirectory` explicitly in
Settings if auto-detection isn't finding the right folder.

**Q: I use Ollama - will it show my models automatically?**
Yes - "Detect Models" queries your local Ollama daemon's real
`/api/tags` endpoint directly, in addition to scanning
`aiTrainer.modelsDir`. If Ollama isn't running, this just contributes
zero extra entries - it isn't treated as an error.

**Q: Can I train something that isn't LoRA?**
Yes - the Training Method dropdown's "Full Fine-Tune" and "Custom"
options let you supply your own real command. Only the "LoRA" preset is
a pre-verified, tested command (from this project's own real pipeline);
the others are honest starting shapes for you to point at your own
training code.

## Reporting a bug

See `CONTRIBUTING.md` for the bug report format this project uses -
please include real, specific reproduction steps and actual error
output, not just "it doesn't work."
