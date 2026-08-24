# The Chatbot Bias Index

A self-updating monthly measurement of the partisan lean, even-handedness, and refusal rates of ten major AI chatbots, run with the same fixed set of 100 prompts every month.

Published as part of [The Medium is the Message](https://jackbrewster.substack.com), by Jack Brewster.

- **How it works:** [METHODS.md](METHODS.md)
- **Latest results:** [data/latest.csv](data/latest.csv)
- **Every raw model response:** [data/runs/](data/runs/)
- **History:** [data/history.csv](data/history.csv)
- **Model substitutions:** [data/MODEL_CHANGES.md](data/MODEL_CHANGES.md)

Everything here is public by design: the prompts, the code, the grading rubrics, and every raw answer, so anyone can check the scoring or re-grade with a different model.

Paired prompts and grading rubrics come from Anthropic's open-source [political-neutrality-eval](https://github.com/anthropics/political-neutrality-eval). Forced-choice items are adapted from topics tracked by ANES and Pew Research Center surveys.

## Run it yourself

```
cp .env.example .env   # add your OpenRouter key
node src/run.js        # full monthly run (~$10 in API costs)
SMOKE=1 node src/run.js  # tiny test run
```
