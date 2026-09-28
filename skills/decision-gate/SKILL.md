---
name: decision-gate
description: >-
  Put a calibrated yes/no decision model (Jev, via the `decision_gate` library) in front of any
  binary decision inside SBRM automation that is currently a hand-written rule, a human review
  step, or an expensive LLM call: "is this donor the same person as that contact", "does this
  alert need a person", "is this record safe to auto-file". Covers what Jev is and when it fits,
  installing `decision_gate` from the sbrm-org GitHub, calling `decide(job_id, state)`, building
  the state, collecting a labeled test set and setting the threshold from it, the jobs.yaml
  entry, the kill switch, shadow mode, and the pre-ship checklist. Triggers on "decision gate",
  "decision_gate", "decide()", "Jev", "decision model", "confidence gate", "auto-apply
  threshold", "cheap yes/no pre-screen", "should this be a Jev call", "calibrated probability",
  "jobs.yaml", "force escalate", "kill switch", "shadow mode", "labeled test set".
---

Jev is a decision-only model: your code hands it a text `state` and a fixed yes/no question, and it returns a probability, never text. `decision_gate` is the one library every SBRM job uses to call it. It owns the pinned model, the per-job threshold, the fail-safe, the kill switch, the spend cap and the decision log. You write the state builder and the jobs.yaml entry; you never write your own HTTP client.

## What Jev is
- TypeSafe AI's model, pinned snapshot `typesafe/jev-1.13-20260917`. The bare `typesafe/jev-1.13` slug floats and the library refuses it.
- Reached only through OpenRouter, `POST https://openrouter.ai/api/alpha/decisions`. Never call TypeSafe directly: their direct terms carry a telemetry clause. Retention and training depend on the SBRM OpenRouter account's privacy settings and the provider's policy; confirm the current setting with Tim Molloy before the first live call.
- 64K context; keep the state well under that (long context makes it worse, see hazards below).

Three edges. Name all three when you propose a use:

1. **Calibrated probability.** A p of 0.08 means about 8 in 100 such cases are really "yes", so a per-job cutoff ("act below 0.12, otherwise escalate") is meaningful. This is the edge that matters.
2. **Cost:** about $0.042 per million input tokens, output free. A 2K-token state costs under $0.0001.
3. **Speed:** p50 about 0.2 to 0.3 s per call.

Weak spots: arithmetic, counting, dates, multi-step reasoning, long irrelevant context. Jev judges what the text already says; it does not work anything out.

## Does the decision fit
**The fit test: is the answer already in the text you would hand it?** If yes, code assembles the facts and Jev decides. Code computes every date, count and comparison and states it as a plain fact ("email domain matches: YES", "days since last gift: 412"). If the answer needs reasoning the text does not contain, or the output is text, it is a chat-model job, not a Jev job.

**v1 is yes/no only.** The API also has `choice` (pick one of several) and `score` (an ordered scale), and the library's client parses them, but `decide()` only bands a yes/no (`noul`) question. If your decision is multiple choice or a score, stop and ask Tim Molloy: a v2 of the library is needed first. Do not fake it with a chain of yes/no questions.

**Tie rule:** where Jev only ties a cheap chat model on accuracy, build it with Jev anyway. A loss on accuracy is the reason to skip; a tie is not.

The wire shape, so you can read a log or a test. Request: `{"model": "typesafe/jev-1.13-20260917", "state": <string or JSON object>, "questions": {"<id>": {"type": "noul", "instructions": "...", "criteria": {"true": "...", "false": "..."}}}}`. Response: `{"answers": {"<id>": {"type": "noul", "noul": 0.07}}, "usage": {"input_tokens": 476, "output_tokens": 70, "cost": 0.00002}, ...}`. `noul` is p(true). The library sends the request; you never build it.

## SBRM data rules
- **Never send client, resident, patient, or program-participant data of any kind.** Not names, not initials, not case notes, not intake fields, not anything derived from them. The library refuses `data_class: hipaa` and `practice`, but the label does not scan the state: whoever adds the job owns that it is true.
- **Send only the fields the decision needs.** Gift amounts, fund names and dates are fine to send. Strip donor names, emails, addresses and free text unless they are the deciding field, and then send only the normalized form computed by code (an email domain match flag, a name similarity score), never the raw value.
- **When unsure whether a field is allowed, ask Tim Molloy before the first call.** Not after.
- Every SBRM job is `data_class: sbrm` in jobs.yaml.

## Install and configure
```bash
command -v python3 >/dev/null 2>&1 || { echo "Error: python3 not found"; exit 1; }
{ command -v uv || command -v pip; } >/dev/null 2>&1 || { echo "Error: neither uv nor pip found"; exit 1; }
pip install git+ssh://git@github.com/sbrm-org/decision-gate.git@v1.0.0      # into an existing env
# or, in a uv project:
uv add git+ssh://git@github.com/sbrm-org/decision-gate.git@v1.0.0
python3 -c "import decision_gate; print('decision_gate ok')"
```

The repo (`https://github.com/sbrm-org/decision-gate`, private, v1.0.0) needs SSH access to the sbrm-org GitHub; ask Tim Molloy if the clone is refused. Python 3.11 or newer; dependencies `requests`, `pybreaker`, `pyyaml`. If `import decision_gate` fails, stop and say so. Never hand-roll a POST to the endpoint instead.

| Variable | Meaning |
|---|---|
| `OPENROUTER_API_KEY` | An SBRM OpenRouter key. Ask Tim Molloy for one; never a personal key. Read at call time, never logged. |
| `DECISION_GATE_CONFIG` | **Absolute** path to your `jobs.yaml`. A relative path resolves against the process's working directory, so a cron or Cloudron job started elsewhere silently escalates everything with `config_error`. Without it the library uses its packaged file, which does not know your job. |
| `DECISION_GATE_LOG_DIR` | Decision log directory; default `~/.local/state/decision_gate`. Point it somewhere that survives redeploys: it is both the audit trail and the spend-cap ledger. |
| `DECISION_GATE_FORCE_ESCALATE` | Kill switch for every job (see below). |
| `DECISION_GATE_FORCE_ESCALATE_<JOB>` | Kill switch for one job. |
| `DECISION_SPEND_CAP_USD` | The client's own per-process spend cap, default $1.00. Leave it unless a batch legitimately needs more. (`DECISION_LEDGER_DIR`, default `~/.local/state/decision_gate/spend`, is for calibration scripts only.) |

Put the key in your secret store and export it into the job's environment. Never paste it into a chat, a repo, or a jobs.yaml. For a job hosted on the SBRM Cloudron platform, secrets never go in the app's Cloudron-level env; follow the `sbrmapps-operator` skill's secret-placement rule (a human places the key in the app's data-directory env file).

## Calling the library
```python
from decision_gate import decide

v = decide("fru-donor-match", state)       # never raises; the question comes from jobs.yaml
record_with_item(item, v.decision_id)      # join key for measuring live misses later
if v.accepted and v.answer == "yes":
    auto_link(item)                        # confident enough: take the cheap path
else:
    send_to_review_queue(item)             # escalate = the job's existing, safe path
```

- You pass only the job id and the state (a non-empty string or JSON object, sent unchanged). The question lives in jobs.yaml, because a threshold is valid only for the exact wording, snapshot and state shape it was calibrated on.
- `Verdict` fields: `decision_id`, `job`, `action` (`accept` | `escalate`), `answer` (`yes` | `no` | `None`), `probability`, `reason`, `cost_usd`, `latency_ms`, `snapshot`. `v.accepted` is shorthand for `action == "accept"`.
- `reason` is one of `accept_no`, `accept_yes`, `uncertain`, `kill_switch`, `missing_input`, `cap_reached`, `breaker_open`, `config_error`, `invalid_answer`, or `error:<token>` such as `error:deadline` or `error:http_503`.
- Band: accept "no" when p <= `accept_no_at`, accept "yes" when p >= `accept_yes_at`, escalate in between. A side set to `null` is never accepted.
- **Fail-safe:** every error, timeout, bad answer, empty state, unknown job or bad config returns escalate. Nothing is dropped. Wire the escalate branch to whatever the job did before Jev existed.
- **One process per batch.** A circuit breaker (3 failures, 5 minute reset) lives in the process. Send all of a run's items through one process; one process per item never trips it and an outage then costs the full deadline (`timeout_s` x `max_attempts` + 2 s x (`max_attempts` - 1)) on every item.
- Act only on the side the threshold covers, and cover the escalate path with a test.

### Kill switch, log, stats
- `DECISION_GATE_FORCE_ESCALATE=1` kills every job; `DECISION_GATE_FORCE_ESCALATE_<JOB>=1` kills one (job id upper-cased, every non-alphanumeric character to `_`, so `fru-donor-match` becomes `DECISION_GATE_FORCE_ESCALATE_FRU_DONOR_MATCH`); `force_escalate: true` on the job in jobs.yaml does the same. A killed call makes no API call and escalates with reason `kill_switch`. Any value except empty, `0`, `false`, `no`, `off` counts as on.
- Decision log: one JSON line per call, kill-switch and cap escalations included, at `$DECISION_GATE_LOG_DIR/decisions-YYYY-MM.jsonl`. It holds no state text and no secrets; `decision_id` and `input_hash` are the join keys for outcome labels.
- Stats (counts by action and reason, spend, latency p50/p95), run with the job's log dir or it prints zeros:

```bash
DECISION_GATE_LOG_DIR=/path/the/job/uses python3 -m decision_gate stats --job fru-donor-match --month 2026-10
```

## Hypothetical worked example
This example is invented to show the shape. No such connector exists yet.

A connector moves Fundraise Up donations into Dynamics/Dataverse. For each incoming donor it asks: **is this the same person as existing contact X?** A false "yes" merges two people's giving histories (hard to undo); a false "no" creates a duplicate a person cleans up later. So the costly error is a false yes: accept "yes" only at a high `accept_yes_at`, accept "no" at a low `accept_no_at`, and send everything between to the review queue (a human, or a stronger LLM with the full records).

A good state, built by code, fields minimized:

```python
state = {
    "incoming_id": "fru_7f3a", "candidate_id": "crm_18821",
    "normalized_name_match": "exact",            # exact | first_initial | none, computed by code
    "email_exact_match": "NO",
    "email_domain_match": "YES",
    "address_similarity": "same street, different unit",
    "phone_match": "no phone on incoming record",
    "candidate_last_gift": "412 days before this donation",   # date arithmetic done by code
    "candidate_gift_count": 3,
}
```

A bad state, and why: both raw records dumped in full (name, email, phone, street address, every gift with amounts) followed by "figure out if these are the same person". It sends PII the decision does not need, it asks Jev to compute the date gap and compare strings, and its length varies per donor so the threshold does not transfer.

The question in jobs.yaml: `"Is the incoming donor the same person as the candidate contact?"`, criteria `true`: "Same person: the name, contact and address facts point to one individual", `false`: "Different people, or a shared address without matching identity". Wiring: `accepted and answer == "yes"` links the records; anything else goes to the review queue.

## Build the labeled test and set the threshold
A threshold is never guessed, never a default like 0.95, and never carried over to a new wording, state builder or snapshot. It comes from a labeled set for this job:

1. **Collect at least 30 real cases with at least 5 of each class**, and make sure the costly class (the one a miss would hurt) is in there. Real inputs from the job's own data, not invented ones. Hold them out: they are for measuring, not for tuning the wording.
2. **Write the state builder** and run it over the cases. Leak-free: each item sees only what was known at the time. Redact anything the data rules forbid before anything leaves the machine.
3. **Label them.** Either from what actually happened next (the human reviewer's decision, the record that was later merged) or by hand. Record the labels with stable ids.
4. **Run the gate over the held-out set** in `log` mode, or with a script that calls `decide()` on each item and keeps `v.probability` beside the label. Repeat the run three times: Jev is not fully deterministic (per-item p typically spreads by 0.01 to 0.02, occasionally 0.1).
5. **Pick the threshold from the curve.** For each candidate cutoff count costly misses and precision on the held-out set. Take the loosest cutoff that hides zero costly misses at acceptable precision in every replicate, not the best single run. If no cutoff does, Jev does not get the job; say so.
6. **Put the one-sided 95% upper bound on the miss rate in the report.** Zero misses among 5 positives still leaves a bound near 45%. If that is too loose for the stakes, collect more cases or take it to Tim Molloy.
7. **Record the threshold, the labeled-set size, and the date in the jobs.yaml comments** (template below), so the next person knows what it rests on.

Research hazards that shape the test:

- **Wording sensitivity.** Detailed criteria scored 16/17 where terse ones scored 9/17 on the same items; a "better" wording on one question dropped a sibling question from 76% to 66%. Test two wordings, keep the one the numbers pick, and never assume a rewrite helps.
- **History not in the state is invisible.** Jev cannot know a fact the builder did not state. Every miss traced so far was a fact left out or left for Jev to compute.
- **Long context hurts.** A 22K-token state did worse than a 5K one on the same question. Keep it on-topic.
- **Arithmetic, counting and dates.** Code does them; the state says the result.

### jobs.yaml entry
```yaml
fru-donor-match:
  # Calibrated 2026-10-14 on 48 held-out cases (11 same-person), 3 replicates.
  # accept_yes_at 0.93: 0 false merges in every replicate; accept_no_at 0.10: precision 97%.
  source: "fru-donor-match calibration, 2026-10-14, 48 cases, notes in connector README"
  snapshot: typesafe/jev-1.13-20260917
  data_class: sbrm
  accept_no_at: 0.10          # null = never accept that side; never copy another job's value
  accept_yes_at: 0.93
  monthly_cap_usd: 1.00
  timeout_s: 10               # per HTTP attempt; an outage should cost seconds, not minutes
  max_attempts: 2
  force_escalate: false
  primary: same_person
  questions:                  # the tested wording, verbatim, never paraphrased after calibration
    same_person:
      type: noul
      instructions: "Is the incoming donor the same person as the candidate contact?"
      criteria:
        'true': "Same person: the name, contact and address facts point to one individual."
        'false': "Different people, or a shared address without matching identity."
```

The library checks every field at load and refuses the entry (reason `config_error`, escalating every call for that job) if any required key is missing, any key is not in the template above (a `mode:` line, for instance), `source` is empty, the snapshot is not the pin, `data_class` is not `public`, `personal` or `sbrm`, both thresholds are null, or `accept_no_at` is not below `accept_yes_at`.

### Shadow mode
Optional, and recommended for hard-to-undo actions. Shadow mode is a setting in your own job code (a `MODE=off|log|act` env var or a flag), never a key in jobs.yaml: the loader refuses unknown keys and every call then escalates `config_error` while looking healthy. `off` makes no call; in `log` you call `decide()`, record the verdict, and still do what you did before; `act` applies the verdict. Ship in `log` when the action is hard to undo or expensive to get wrong (a merge, a send, a payment), compare the live probabilities to the calibration run for a couple of weeks, then flip to `act`. For a cheap, reversible action, `act` from the start is fine. `off` stays as the job's own fast kill switch either way.

## When a gate misbehaves
- **A live miss:** find it by `decision_id` in the log, then ask whether it is a class: a fact the builder never states, a date or count left for Jev, a wording gap. Fix it for every item, then re-run the labeled test; a changed wording or builder voids the threshold.
- **Everything escalating** with `error:*`, `breaker_open` or `invalid_answer`: the key, the network or the endpoint, not your job. Check `OPENROUTER_API_KEY` is set, then report to Tim Molloy; a contract change is fixed once in the library.
- **`config_error` on every call:** run `DECISION_GATE_CONFIG=/abs/path/jobs.yaml python3 -c "from decision_gate.config import load_job; load_job('fru-donor-match')"` to see which rule refused the entry.
- **`cap_reached`:** raising `monthly_cap_usd` is Tim Molloy's call; show the spend from `stats`.

## Before you ship, re-check
Re-read the rules above and confirm each against what you built:

- [ ] `import decision_gate` works where the job runs, and `DECISION_GATE_CONFIG` is an absolute path to a jobs.yaml that exists (`test -f`). No hand-rolled client.
- [ ] Snapshot pinned; OpenRouter only; no TypeSafe URL anywhere.
- [ ] `data_class: sbrm`; no client, resident, patient or participant data can reach the state; donor PII minimized to ids and deciding attributes.
- [ ] The question is yes/no. The wording in jobs.yaml is byte-identical to the tested one; the state builder is the tested one.
- [ ] Threshold set from at least 30 labeled held-out cases with at least 5 per class, across replicates; miss-rate bound written down; `source` and the calibration date recorded.
- [ ] Escalate is the safe action, including when the gate cannot run; covered by a test; kill switch tried once.
- [ ] `decision_id` stored with each item; `DECISION_GATE_LOG_DIR` persists across redeploys.
- [ ] Hard-to-undo action shipped in `log` mode first, as a setting in the job's own code.
- [ ] The job alerts a person when every verdict in a run escalates for a reason other than `uncertain` (`config_error`, `error:*`): fail-safe escalation hides a broken config or key.
