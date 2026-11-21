# Test results

Recorded evidence for each epic's "done when" criteria.

- `epic-1/live-results.md`: a summary of the latest live mapping run (model, prompt version, commit, each scenario's result, calls, repairs, latency).
- `epic-1/live-results.json`: the same data in machine-readable form.
- `epic-1/drafts/`: the draft (or error) each scenario produced.

Every file in `epic-1/` is rewritten by `npm run test:live`. Live runs call the model once per scenario, so results can vary between runs. Repeated accuracy runs are deferred.
