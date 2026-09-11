# Contributing / reporting bugs

Feedback and bug reports are genuinely welcome - this is a small, young
tool and real usage is the fastest way to find what's actually broken.

## Bug report format

This project's own development used a consistent, real format for
documenting bugs - carrying it forward here because it works: state
what actually happened, not a guess at the cause, then (if known) what
the real root cause turned out to be.

```
**What happened**: <the real, observed symptom - exact error text,
what you clicked, what you expected instead>

**Steps to reproduce**: <real, specific steps - "open the Train tab,
select model X, click Start" not "sometimes it breaks">

**Environment**: OS, VS Code version, what your aiTrainer.trainCommand/
chatCommand actually is (redact anything sensitive)

**Root cause** (if you know it, otherwise leave blank - a real
maintainer will investigate): <what's actually wrong, once found - not
a guess presented as fact>

**Suggested fix** (optional): <a real, concrete proposal, if you have
one>
```

Please avoid vague reports ("it's broken," "doesn't work right") -
this project's own standing rule for itself is **never guess at a fix
without verifying the real, specific symptom first**, and a bug report
that includes real reproduction steps and real error output makes that
possible.

## Opening an issue

Use the repository's GitHub Issues. Include the bug report format above.
Feature requests and general feedback are also welcome - open an issue
and describe the real use case you're trying to solve, not just the
feature name.

## Pull requests

Small, real, focused changes are easiest to review. If you're planning
something larger, open an issue first to discuss the approach before
writing a lot of code that might not fit.
